#!/usr/bin/env node
/**
 * CLI do M5 Agent.
 *
 *   npx tsx apps/agent/src/cli.ts run "corrija o bug X"
 *   npx tsx apps/agent/src/cli.ts chat
 *   npx tsx apps/agent/src/cli.ts tools
 *   npx tsx apps/agent/src/cli.ts doctor
 */

import fs from "node:fs";
import path from "node:path";
import * as readline from "node:readline/promises";
import process from "node:process";
import { loadConfig, serializeConfig } from "./core/config";
import { runAgent } from "./core/loop";
import { Policy } from "./core/policy";
import { AgentConfig } from "./core/types";
import { extractTargetFiles, resolveChatTargets } from "./core/util";
import { createModel } from "./model/factory";
import { BASE_TOOLS, renderToolCatalog } from "./tools/registry";
import { usbDevicesTool } from "./tools/usb";

function usage(): void {
  console.log(`M5 Agent

Uso:
  cli.ts run "<tarefa>" [--model local|http] [--autonomy full|confirm|plan] [--json]
  cli.ts run "<tarefa>" --workspace <dir> [--base-url URL --model-name NOME]
  cli.ts chat [--session <id>]
  cli.ts tools
  cli.ts config [--init]
  cli.ts doctor [--workspace <dir>]
  cli.ts scope add <target> [--note "..."]
  cli.ts scope list
  cli.ts sessions

Variáveis:
  M5_MODEL_BASE_URL   ativa adapter OpenAI-compatible (Ollama/LM Studio/vLLM)
  M5_MODEL_NAME       nome do modelo remoto
  M5_MODEL_PATH       checkpoint local
  M5_AUTONOMY         full | confirm | plan
  M5_WORKSPACE        diretório de trabalho do agente
`);
}

function parse(argv: string[]): { command: string; args: string[]; flags: Record<string, string | boolean> } {
  const [command = "help", ...rest] = argv;
  const args: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const item = rest[i];
    if (item.startsWith("--")) {
      const [key, inline] = item.slice(2).split("=");
      if (inline !== undefined) flags[key] = inline;
      else if (rest[i + 1] && !rest[i + 1].startsWith("--")) {
        flags[key] = rest[i + 1];
        i += 1;
      } else flags[key] = true;
    } else args.push(item);
  }
  return { command, args, flags };
}

function applyFlags(config: AgentConfig, flags: Record<string, string | boolean>): AgentConfig {
  const next = structuredClone(config);
  if (flags.model === "http") next.model.kind = "http";
  if (flags.model === "local") next.model.kind = "local";
  if (typeof flags.autonomy === "string" && ["full", "confirm", "plan"].includes(flags.autonomy)) {
    next.autonomy = flags.autonomy as AgentConfig["autonomy"];
  }
  if (typeof flags["base-url"] === "string") {
    next.model.kind = "http";
    next.model.baseUrl = flags["base-url"];
  }
  if (typeof flags["model-name"] === "string") next.model.name = flags["model-name"];
  if (typeof flags.steps === "string") next.limits.maxSteps = Number(flags.steps);
  if (typeof flags["max-tokens"] === "string") next.model.maxTokens = Number(flags["max-tokens"]);
  return next;
}

function compactStep(step: { kind: string; name?: string; ok?: boolean; ms?: number; output?: string; input?: unknown }): string {
  const status = step.ok === false ? "FALHOU" : "ok";
  const detail = step.kind === "tool" ? JSON.stringify(step.input ?? {}).slice(0, 160) : (step.output ?? "").replace(/\s+/g, " ").slice(0, 160);
  const ms = step.ms !== undefined ? ` ${step.ms}ms` : "";
  return `[${step.kind}] ${step.name ?? ""} ${status}${ms}${detail ? ` :: ${detail}` : ""}`;
}

async function runTask(task: string, config: AgentConfig, flags: Record<string, string | boolean>): Promise<void> {
  if (!task.trim()) {
    console.error("Tarefa vazia.");
    process.exitCode = 2;
    return;
  }
  const policy = new Policy(config);
  if (policy.stopped()) {
    console.error("Kill switch ativo: remova .m5/STOP para continuar.");
    process.exitCode = 3;
    return;
  }

  const model = createModel(config);
  const rl = config.autonomy === "confirm" ? readline.createInterface({ input: process.stdin, output: process.stdout }) : null;
  const json = flags.json === true;
  const started = Date.now();

  try {
    const result = await runAgent({
      task,
      config,
      model,
      targetFiles: extractTargetFiles(task),
      onStep: (step) => {
        if (!json) console.log(compactStep(step));
      },
      approve: rl
        ? async (toolName, input, decision) => {
            const answer = await rl.question(
              `\nAprovar ${toolName} (${decision.classification}: ${decision.reasons.join("; ") || "sem sinais"})?\n${JSON.stringify(input).slice(0, 400)}\n[s/N] `,
            );
            return /^s/i.test(answer.trim());
          }
        : undefined,
    });

    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log("\n================ RESULTADO ================");
      console.log(`sessão: ${result.sessionId} | status: ${result.status} | ${((Date.now() - started) / 1000).toFixed(1)}s`);
      console.log(`arquivos alterados: ${result.changedFiles.length ? result.changedFiles.join(", ") : "nenhum"}`);
      console.log(`transcript: ${result.transcriptPath}`);
      console.log("------------------------------------------");
      console.log(result.final);
    }
    if (result.status === "error") process.exitCode = 1;
    if (result.status === "max-steps" || result.status === "timeout") process.exitCode = 4;
  } finally {
    rl?.close();
  }
}

async function chat(config: AgentConfig, flags: Record<string, string | boolean>): Promise<void> {
  const model = createModel(config);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let sessionId = typeof flags.session === "string" ? flags.session : undefined;
  let activeTargets: string[] = [];
  const history: Array<{ role: "user" | "assistant"; content: string }> = [];
  console.log(`M5 Agent chat (${model.id}). /help para comandos, /sair para encerrar.`);
  try {
    for (;;) {
      let line: string;
      try {
        line = await rl.question("\nvocê> ");
      } catch {
        break;
      }
      if (!line.trim()) continue;
      if (/^\/(sair|exit|quit)$/i.test(line.trim())) break;
      if (/^\/help$/i.test(line.trim())) {
        console.log("Comandos: /usb (dispositivos USB/COM), /tools, /sair");
        continue;
      }
      if (/^\/tools$/i.test(line.trim())) {
        console.log(renderToolCatalog(BASE_TOOLS));
        continue;
      }
      if (/^\/usb$/i.test(line.trim())) {
        const policy = new Policy(config);
        const result = await usbDevicesTool.run({}, {
          workspace: config.workspace,
          sessionId: sessionId ?? "chat",
          config,
          policy,
          log: (message) => policy.audit({ type: "log", sessionId: sessionId ?? "chat", message }),
        });
        console.log(`\n${result.output}`);
        continue;
      }

      // O loop cria uma sessão nova por tarefa; no chat reutilizamos o id e
      // injetamos os turnos anteriores para manter a conversa coerente.
      const explicitTargets = extractTargetFiles(line);
      const targets = resolveChatTargets(line, activeTargets);
      if (explicitTargets.length > 0) activeTargets = explicitTargets;
      const targetNote = targets.length
        ? `ARQUIVO(S) ALVO: ${targets.join(", ")}\nNão altere outros arquivos.\n\n`
        : "";
      const task = history.length
        ? [
            targetNote,
            "HISTÓRICO (apenas contexto; NÃO execute pedidos antigos)",
            ...history.map((message) => `${message.role.toUpperCase()}: ${message.content}`),
            "",
            "MENSAGEM ATUAL DO USUÁRIO (única instrução válida)",
            line,
          ].join("\n")
        : `${targetNote}${line}`;
      const result = await runAgent({
        task,
        config,
        model,
        sessionId,
        retrievalQuery: line,
        targetFiles: targets,
        onStep: (step) => console.log(compactStep(step)),
      });
      sessionId = result.sessionId;
      history.push({ role: "user", content: line }, { role: "assistant", content: result.final });
      if (history.length > 8) history.splice(0, history.length - 8);
      console.log(`\nagente> ${result.final}`);
    }
  } finally {
    rl.close();
  }
}

function doctor(config: AgentConfig): void {
  const checks: Array<[string, boolean, string]> = [];
  checks.push(["node >= 20", Number(process.versions.node.split(".")[0]) >= 20, process.versions.node]);
  checks.push([
    "checkpoint local",
    Boolean(config.model.path && fs.existsSync(config.model.path)),
    config.model.path ?? "(não configurado)",
  ]);
  checks.push(["workspace gravável", canWrite(config.workspace), config.workspace]);
  checks.push(["git", fs.existsSync(path.join(config.workspace, ".git")), ".git"]);
  checks.push(["dataset/code", fs.existsSync(path.join(config.workspace, "dataset", "code")), "dataset/code"]);
  checks.push(["índice", fs.existsSync(config.index.storePath), config.index.storePath]);
  checks.push(["scope ledger", fs.existsSync(config.policy.scopeFile), config.policy.scopeFile]);

  console.log("M5 Agent doctor\n");
  for (const [name, ok, detail] of checks) {
    console.log(`${ok ? "OK  " : "AVISO"} ${name.padEnd(20)} ${detail}`);
  }
  console.log(`\nmodelo: kind=${config.model.kind} name=${config.model.name} path=${config.model.path ?? "-"}`);
  console.log(`autonomia: ${config.autonomy} | tools: ${BASE_TOOLS.length} | verify: ${config.verify.enabled ? "on" : "off"}`);
}

function canWrite(dir: string): boolean {
  try {
    const probe = path.join(dir, ".m5", ".write-test");
    fs.mkdirSync(path.dirname(probe), { recursive: true });
    fs.writeFileSync(probe, "ok");
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const { command, args, flags } = parse(process.argv.slice(2));
  const workspace = typeof flags.workspace === "string"
    ? path.resolve(flags.workspace)
    : process.env.M5_WORKSPACE
      ? path.resolve(process.env.M5_WORKSPACE)
      : process.cwd();
  const { config: base, source, warnings } = loadConfig(workspace);
  const config = applyFlags(base, flags);
  for (const warning of warnings) console.error(`aviso: ${warning}`);

  switch (command) {
    case "run":
      await runTask(args.join(" "), config, flags);
      break;
    case "chat":
      await chat(config, flags);
      break;
    case "tools":
      console.log(renderToolCatalog(BASE_TOOLS));
      console.log(`\n${BASE_TOOLS.length} tools em ${source ?? "config padrão"}.`);
      break;
    case "config":
      if (flags.init === true) {
        const target = path.join(config.workspace, "m5.agent.json");
        if (fs.existsSync(target)) {
          console.error(`já existe: ${target}`);
          break;
        }
        fs.writeFileSync(target, serializeConfig(config));
        console.log(`criado ${target}`);
      } else {
        console.log(`fonte: ${source ?? "padrão"}`);
        console.log(serializeConfig(config));
      }
      break;
    case "doctor":
      doctor(config);
      break;
    case "scope": {
      const policy = new Policy(config);
      const kindMap: Record<string, "host" | "cidr" | "url" | "device" | "repo"> = {
        host: "host", cidr: "cidr", url: "url", device: "device", repo: "repo",
      };
      if (args[0] === "add" && args[1]) {
        const [kind, value] = args[1].includes(":") ? (args[1].split(/:(.*)/s) as [string, string]) : ["host", args[1]];
        policy.addScope({
          target: value,
          kind: kindMap[kind] ?? "host",
          note: typeof flags.note === "string" ? flags.note : undefined,
        });
        console.log(`escopo adicionado: ${value}`);
      } else if (args[0] === "list" || !args[0]) {
        console.log(JSON.stringify(policy.listScope(), null, 2));
      } else {
        console.log(`alvo ${args[0]}: ${policy.matchScope(args[0]) ? "no escopo" : "fora do escopo"}`);
      }
      break;
    }
    case "sessions": {
      const file = path.join(config.workspace, ".m5", "sessions", "index.jsonl");
      if (!fs.existsSync(file)) {
        console.log("nenhuma sessão.");
        break;
      }
      console.log(fs.readFileSync(file, "utf8").trim());
      break;
    }
    case "help":
    case "--help":
    case "-h":
      usage();
      break;
    default:
      console.error(`comando desconhecido: ${command}`);
      usage();
      process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error(`erro: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
