#!/usr/bin/env node
/**
 * Teste de produção do M5 Agent.
 *
 * Executa, em sequência:
 *  1. typecheck estrito de todo o pacote;
 *  2. suíte completa de testes;
 *  3. geração/validação das 14 linguagens (11.200 amostras);
 *  4. integridade do manifest e dos splits em disco;
 *  5. build + busca + repo map do índice;
 *  6. integridade do dataset defensivo de segurança;
 *  7. laboratórios de redes/embarcados/seclab;
 *  8. E2E real do CLI com adapter HTTP (servidor OpenAI-compatible local),
 *     incluindo execução de tool, arquivo gerado, sessão e audit log.
 *
 * Uso:
 *   npm run agent:prodtest
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateAll } from "../src/datasets/registry.ts";
import { validateSamples } from "../src/datasets/quality.ts";
import { search } from "../src/index/query.ts";
import { renderRepoMap } from "../src/index/repoMap.ts";
import {
  buildIndex,
  indexStats,
  loadIndex,
  saveIndex,
} from "../src/index/store.ts";
import { knoxGuardFacts } from "../src/modules/embedded/android.ts";
import { listLabs } from "../src/modules/net/labs.ts";
import { mitigationsTable } from "../src/modules/seclab/overflow.ts";
import { generateSecurityTuneSamples } from "../src/datasets/security-tune.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const cliPath = path.join(repoRoot, "apps", "agent", "src", "cli.ts");

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
  ms: number;
}

const results: CheckResult[] = [];
let failures = 0;
const only = process.argv.find((arg) => arg.startsWith("--only="))?.slice("--only=".length).toLowerCase();

async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  if (only && !name.toLowerCase().includes(only)) {
    console.log(`SKIP ${name}`);
    return;
  }
  const started = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, detail: "ok", ms: Date.now() - started });
    console.log(`PASS ${name} (${Date.now() - started}ms)`);
  } catch (error) {
    failures += 1;
    const detail = error instanceof Error ? error.message : String(error);
    results.push({ name, ok: false, detail, ms: Date.now() - started });
    console.error(`FAIL ${name} (${Date.now() - started}ms)\n     ${detail}`);
  }
}

function runNpm(script: string, timeoutMs = 600_000): void {
  const command = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "npm";
  const args = process.platform === "win32"
    ? ["/d", "/s", "/c", `npm run ${script}`]
    : ["run", script];
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: timeoutMs,
    env: { ...process.env, CI: "1" },
  });
  if (result.status !== 0) {
    const tail = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim().split(/\r?\n/).slice(-25).join("\n");
    throw new Error(`${script} saiu com código ${result.status}\n${tail}`);
  }
}

interface CliRun {
  status: number | null;
  signal: NodeJS.Signals | null;
  output: string;
}

/**
 * Executa o CLI de forma assíncrona. `spawnSync` não serve aqui porque
 * bloquearia o event loop do processo de teste, impedindo o servidor HTTP
 * mock de responder às requisições do próprio CLI.
 */
function runCli(args: string[], timeoutMs: number): Promise<CliRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      env: { ...process.env, M5_AUTONOMY: "full" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let timedOut = false;
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += String(chunk);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      if (timedOut) output += `\n[timeout após ${timeoutMs}ms]`;
      resolve({ status, signal, output });
    });
  });
}

function countLines(file: string): number {
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0).length;
}

function tempWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "m5-prod-"));
}

function startMockModel(): Promise<{ server: http.Server; port: number; calls: () => number }> {
  let calls = 0;
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += String(chunk);
    });
    request.on("end", () => {
      calls += 1;
      const first = calls === 1;
      const content = first
        ? `<tool name="write_file">${JSON.stringify({
            path: "src/production.ts",
            content: "export const PRODUCTION_TEST = true;\n",
          })}</tool>`
        : "<final>produção ok: arquivo criado e verificado</final>";
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content } }],
          usage: { prompt_tokens: Math.max(1, Math.ceil(body.length / 4)), completion_tokens: 8 },
        }),
      );
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("endereço do servidor mock inválido"));
        return;
      }
      resolve({ server, port: address.port, calls: () => calls });
    });
  });
}

async function main(): Promise<void> {
  console.log("M5 Agent — teste de produção\n");
  console.log(`workspace: ${repoRoot}`);
  console.log(`node:      ${process.version}\n`);

  await check("typecheck estrito", () => {
    runNpm("agent:typecheck");
  });

  await check("suíte completa de testes", () => {
    runNpm("agent:test");
  });

  await check("dataset: 14 linguagens com >= 800 amostras válidas", () => {
    const generated = generateAll();
    assert.equal(generated.length, 14);
    for (const language of generated) {
      assert.ok(
        language.full.length >= 800,
        `${language.key}: ${language.full.length} amostras`,
      );
    }
    const quality = validateSamples(generated.flatMap((item) => item.full));
    assert.equal(quality.ok, true, quality.errors.slice(0, 5).map((e) => e.message).join("; "));
    assert.equal(quality.stats.total, 11_200);
    assert.equal(quality.stats.duplicateCodeHashes, 0);
  });

  await check("dataset: manifest e splits em disco", () => {
    const manifestPath = path.join(repoRoot, "dataset", "code", "manifest.json");
    assert.ok(fs.existsSync(manifestPath), `ausente: ${manifestPath}`);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      languages: Array<{ key: string; total: number }>;
      totals: { samples: number; train: number; val: number; test: number };
      quality: { ok: boolean };
    };
    assert.equal(manifest.languages.length, 14);
    assert.equal(manifest.totals.samples, 11_200);
    assert.equal(manifest.totals.train + manifest.totals.val + manifest.totals.test, 11_200);
    assert.equal(manifest.quality.ok, true);
    for (const language of manifest.languages) {
      assert.ok(language.total >= 800, `${language.key}: ${language.total}`);
      for (const split of ["train", "val", "test"]) {
        const file = path.join(repoRoot, "dataset", "code", language.key, `${split}.jsonl`);
        assert.ok(fs.existsSync(file), `ausente: ${file}`);
      }
    }
    assert.equal(
      countLines(path.join(repoRoot, "dataset", "code", "all", "train.jsonl")),
      manifest.totals.train,
    );
  });

  await check("índice: build, busca, repo map e roundtrip", () => {
    const dir = tempWorkspace();
    const store = path.join(dir, "code-index.json");
    try {
      const index = buildIndex({ root: repoRoot, maxFiles: 8_000, storePath: store, useCache: false });
      const stats = indexStats(index);
      assert.ok(stats.files >= 100, `arquivos indexados: ${stats.files}`);
      assert.ok(stats.symbols >= 1_000, `símbolos: ${stats.symbols}`);
      const hits = search(index, "agent loop executa tool e verifica", { limit: 5 });
      assert.ok(hits.length > 0, "busca híbrida não encontrou o loop");
      const repoMap = renderRepoMap(index);
      assert.match(repoMap, /apps\//);
      assert.match(repoMap, /agent\//);
      saveIndex(index, store);
      const reloaded = loadIndex(store);
      assert.ok(reloaded, "índice não recarregou");
      assert.equal(indexStats(reloaded).files, stats.files);
      assert.ok(search(reloaded, "search_code", { limit: 3 }).length > 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await check("segurança: dataset defensivo íntegro", () => {
    const dir = path.join(repoRoot, "dataset", "security");
    const manifestPath = path.join(dir, "manifest.json");
    assert.ok(fs.existsSync(manifestPath), `ausente: ${manifestPath}`);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      defensive: boolean;
      total: number;
      splits: Record<string, number>;
    };
    assert.equal(manifest.defensive, true);
    assert.ok(manifest.total >= 100, `amostras: ${manifest.total}`);
    let total = 0;
    for (const [split, expected] of Object.entries(manifest.splits)) {
      const file = path.join(dir, `${split}.jsonl`);
      assert.ok(fs.existsSync(file), `ausente: ${file}`);
      const lines = countLines(file);
      assert.equal(lines, expected, `${split}: ${lines} != ${expected}`);
      total += lines;
    }
    assert.equal(total, manifest.total);
  });

  await check("segurança: dataset purple/red autorizado e export chat", () => {
    const tuneDir = path.join(repoRoot, "dataset", "security-tune");
    const tuneManifestPath = path.join(tuneDir, "manifest.json");
    assert.ok(fs.existsSync(tuneManifestPath), `ausente: ${tuneManifestPath}`);
    const tuneManifest = JSON.parse(fs.readFileSync(tuneManifestPath, "utf8")) as {
      total: number;
      splits: Record<string, number>;
      safety: { defensive: boolean; authorizedOnly: boolean; noWeaponizedContent: boolean };
    };
    const samples = generateSecurityTuneSamples();
    assert.ok(samples.length >= 500, `amostras: ${samples.length}`);
    assert.equal(tuneManifest.total, samples.length);
    assert.equal(tuneManifest.safety.defensive, true);
    assert.equal(tuneManifest.safety.authorizedOnly, true);
    assert.equal(tuneManifest.safety.noWeaponizedContent, true);
    let tuneTotal = 0;
    for (const [split, expected] of Object.entries(tuneManifest.splits)) {
      const file = path.join(tuneDir, `${split}.jsonl`);
      assert.ok(fs.existsSync(file), `ausente: ${file}`);
      const lines = countLines(file);
      assert.equal(lines, expected, `${split}: ${lines} != ${expected}`);
      tuneTotal += lines;
    }
    assert.equal(tuneTotal, tuneManifest.total);

    const chatDir = path.join(repoRoot, "dataset", "finetune", "security");
    const chatManifestPath = path.join(chatDir, "manifest.json");
    assert.ok(fs.existsSync(chatManifestPath), `ausente: ${chatManifestPath}`);
    const chatManifest = JSON.parse(fs.readFileSync(chatManifestPath, "utf8")) as {
      total: number;
      format: string;
      safety: { noWeaponizedContent: boolean };
      systemPrompt: string;
    };
    assert.equal(chatManifest.total, samples.length);
    assert.equal(chatManifest.format, "chat-jsonl");
    assert.equal(chatManifest.safety.noWeaponizedContent, true);
    assert.match(chatManifest.systemPrompt, /<tool name=/);
    assert.match(chatManifest.systemPrompt, /<final>/);
  });

  await check("módulos: redes, embarcados e seclab", () => {
    const labs = listLabs();
    assert.ok(labs.length >= 6, `labs de rede: ${labs.length}`);
    assert.ok(labs.every((lab) => lab.id && lab.title));
    const knox = knoxGuardFacts();
    assert.equal(knox.requiresConsent, true);
    assert.ok(knox.facts.length >= 5);
    assert.ok(mitigationsTable().length >= 4);
  });

  await check("E2E: CLI + HTTP mock + tool real + sessão + audit", async () => {
    const workspace = tempWorkspace();
    const mock = await startMockModel();
    try {
      const child = await runCli(
        [
          "--import",
          "tsx",
          cliPath,
          "run",
          "crie o arquivo src/production.ts de produção",
          "--workspace",
          workspace,
          "--model",
          "http",
          "--base-url",
          `http://127.0.0.1:${mock.port}/v1`,
          "--model-name",
          "mock-prod",
          "--steps",
          "6",
        ],
        90_000,
      );
      const output = child.output;
      assert.equal(child.status, 0, `CLI saiu com ${child.status} (${child.signal})\n${output.slice(-2000)}`);
      assert.match(output, /status: done/);
      assert.match(output, /produção ok/);
      assert.ok(mock.calls() >= 2, `chamadas ao mock: ${mock.calls()}`);

      const generated = path.join(workspace, "src", "production.ts");
      assert.ok(fs.existsSync(generated), "arquivo gerado pela tool não existe");
      assert.match(fs.readFileSync(generated, "utf8"), /PRODUCTION_TEST = true/);

      const audit = path.join(workspace, ".m5", "audit.jsonl");
      assert.ok(fs.existsSync(audit), "audit log não foi criado");
      const auditEvents = fs
        .readFileSync(audit, "utf8")
        .split(/\r?\n/)
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as { type?: string; sessionId?: string; message?: string });
      assert.ok(auditEvents.length >= 1, "audit log incompleto");
      assert.equal(auditEvents[0]?.type, "log");
      assert.ok(auditEvents[0]?.sessionId, "audit sem sessionId");
      assert.match(auditEvents[0]?.message ?? "", /write_file/);

      const sessions = path.join(workspace, ".m5", "sessions");
      const sessionDirs = fs.existsSync(sessions)
        ? fs.readdirSync(sessions, { withFileTypes: true }).filter((entry) => entry.isDirectory())
        : [];
      assert.ok(sessionDirs.length >= 1, "sessão não foi persistida");
      const sessionDir = path.join(sessions, sessionDirs[0]?.name ?? "");
      assert.ok(fs.existsSync(path.join(sessionDir, "transcript.jsonl")));
      assert.ok(fs.existsSync(path.join(sessionDir, "result.json")));
    } finally {
      await new Promise<void>((resolve) => mock.server.close(() => resolve()));
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  await check("checkpoint local carrega e gera tokens", async () => {
    const checkpoint = path.join(repoRoot, "models", "m5coder.bin");
    if (!fs.existsSync(checkpoint)) {
      throw new Error(`checkpoint ausente: ${checkpoint} (rode npm run agent:train)`);
    }
    const { LocalModelAdapter } = await import("../src/model/local.ts");
    const adapter = LocalModelAdapter.load(checkpoint, "prod-check");
    const response = await adapter.complete({
      messages: [{ role: "user", content: "### USER\nsoma\n### ASSISTANT\n" }],
      maxTokens: 8,
      temperature: 0,
    });
    assert.equal(typeof response.text, "string");
    assert.ok(response.text.length > 0);
    assert.ok((response.usage?.completion ?? 0) > 0);
  });

  console.log("\n================ RESUMO ================");
  const passed = results.filter((item) => item.ok).length;
  for (const result of results) {
    console.log(`${result.ok ? "PASS" : "FAIL"} ${result.name} (${result.ms}ms)`);
  }
  console.log(`\n${passed}/${results.length} verificações passaram.`);
  if (failures > 0) {
    console.error(`${failures} falha(s).`);
    process.exitCode = 1;
  }
}

await main();
