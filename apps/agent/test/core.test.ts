import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultConfig } from "../src/core/config";
import { runAgent } from "../src/core/loop";
import { Policy, cidrContains } from "../src/core/policy";
import { taskPrompt } from "../src/core/prompt";
import { parseModelOutput, validateCall } from "../src/core/protocol";
import { ModelAdapter, ModelRequest, ModelResponse } from "../src/core/types";
import { extractTargetFiles, needsTargetClarification, resolveChatTargets } from "../src/core/util";
import { grepTool, matchGlob, patchFileTool, readFileTool, walkFiles, writeFileTool } from "../src/tools/fs";
import { BASE_TOOLS } from "../src/tools/registry";
import { normalizePowerShellCommand } from "../src/tools/shell";
import { detectVerifyCommands } from "../src/core/verify";

function tempWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "m5-agent-"));
}

test("matchGlob cobre **, * e ?", () => {
  assert.equal(matchGlob("src/**/*.ts", "src/a/b/c.ts"), true);
  assert.equal(matchGlob("src/*.ts", "src/a/b.ts"), false);
  assert.equal(matchGlob("*.md", "README.md"), true);
  assert.equal(matchGlob("src/?.ts", "src/a.ts"), true);
  assert.equal(matchGlob("src/?.ts", "src/ab.ts"), false);
});

test("CIDR contains e classificação de política", () => {
  assert.equal(cidrContains("10.0.0.0/8", "10.20.30.40"), true);
  assert.equal(cidrContains("10.0.0.0/8", "11.0.0.1"), false);
  assert.equal(cidrContains("192.168.1.0/24", "192.168.1.255"), true);
  assert.equal(cidrContains("0.0.0.0/0", "8.8.8.8"), true);

  const config = defaultConfig(tempWorkspace());
  const policy = new Policy(config);
  assert.equal(policy.classifyCommand("git status").classification, "safe");
  assert.equal(policy.classifyCommand("rm -rf build").classification, "destructive");
  assert.equal(policy.classifyCommand("curl https://example.com").classification, "network");
  assert.equal(policy.classifyCommand("sudo apt install nmap").classification, "privileged");
});

test("parseModelOutput extrai chamadas e final", () => {
  const tools = BASE_TOOLS.map((t) => t.spec);
  const output = `
Vou ler o arquivo.
<tool name="read_file">{"path":"a.ts"}</tool>
<call name="grep">{"pattern":"foo","include":"*.ts"}</call>
<final>Li e encontrei.</final>`;
  const parsed = parseModelOutput(output, tools);
  assert.equal(parsed.calls.length, 2);
  assert.equal(parsed.calls[0].name, "read_file");
  assert.deepEqual(parsed.calls[0].input, { path: "a.ts" });
  assert.equal(parsed.calls[1].name, "grep");
  assert.equal(parsed.final, "Li e encontrei.");
});

test("parseModelOutput aceita bloco JSON com tool/input", () => {
  const tools = BASE_TOOLS.map((t) => t.spec);
  const parsed = parseModelOutput(
    '```json\n{"tool":"read_file","input":{"path":"x.ts"}}\n```',
    tools,
  );
  assert.equal(parsed.calls.length, 1);
  assert.equal(parsed.calls[0].name, "read_file");
});

test("validateCall detecta campo obrigatório ausente", () => {
  const spec = BASE_TOOLS.find((t) => t.spec.name === "read_file")!.spec;
  assert.equal(validateCall({ name: "read_file", input: {}, raw: "" }, spec), "campo obrigatório ausente: path");
  assert.equal(validateCall({ name: "read_file", input: { path: "a" }, raw: "" }, spec), null);
});

test("tools de fs criam, leem, editam, buscam e listam", async () => {
  const ws = tempWorkspace();
  const config = defaultConfig(ws);
  const policy = new Policy(config);
  const ctx = {
    workspace: ws,
    sessionId: "test",
    config,
    policy,
    log: () => undefined,
  };

  await writeFileTool.run({ path: "src/a.ts", content: "export const a = 1;\nexport const b = 2;\n" }, ctx);
  const read = await readFileTool.run({ path: "src/a.ts" }, ctx);
  assert.equal(read.ok, true);
  assert.match(read.output, /export const a = 1/);

  const patched = await patchFileTool.run(
    { path: "src/a.ts", oldString: "export const b = 2;", newString: "export const b = 3;" },
    ctx,
  );
  assert.equal(patched.ok, true);
  const after = fs.readFileSync(path.join(ws, "src/a.ts"), "utf8");
  assert.match(after, /b = 3/);
  const backups = walkFiles(path.join(ws, ".m5", "backups"), { maxFiles: 100 });
  assert.ok(backups.some((file) => file.replace(/\\/g, "/").endsWith("src/a.ts")));

  const ambiguous = await patchFileTool.run(
    { path: "src/a.ts", oldString: "export const", newString: "export let" },
    ctx,
  );
  assert.equal(ambiguous.ok, false);

  fs.writeFileSync(path.join(ws, "crlf.txt"), "linha1\r\nlinha2\r\n");
  const crlf = await patchFileTool.run(
    { path: "crlf.txt", oldString: "linha1\nlinha2\n", newString: "linha1\nlinha3\n" },
    ctx,
  );
  assert.equal(crlf.ok, true);
  assert.equal(fs.readFileSync(path.join(ws, "crlf.txt"), "utf8"), "linha1\r\nlinha3\r\n");

  const grep = await grepTool.run({ pattern: "const b", include: "*.ts" }, ctx);
  assert.equal(grep.ok, true);
  assert.match(grep.output, /src\/a\.ts:2/);

  const escaped = await readFileTool.run({ path: "../../secret.txt" }, ctx);
  assert.equal(escaped.ok, false);
});

test("fs corrige caminho com hífen ausente e sugere alternativas", async () => {
  const ws = tempWorkspace();
  const config = defaultConfig(ws);
  const policy = new Policy(config);
  const ctx = {
    workspace: ws,
    sessionId: "test-path",
    config,
    policy,
    log: () => undefined,
  };
  const real = path.join(ws, "cli", "mini-gpt", "train.ts");
  fs.mkdirSync(path.dirname(real), { recursive: true });
  fs.writeFileSync(real, "export const ok = true;\n");

  const read = await readFileTool.run({ path: "cli\\minigpt\\train.ts" }, ctx);
  assert.equal(read.ok, true);
  assert.match(read.output, /caminho corrigido/);
  assert.match(read.output, /export const ok = true/);

  const patched = await patchFileTool.run(
    { path: "cli/minigpt/train.ts", oldString: "ok = true", newString: "ok = false" },
    ctx,
  );
  assert.equal(patched.ok, true);
  assert.match(fs.readFileSync(real, "utf8"), /ok = false/);

  const missing = await readFileTool.run({ path: "cli/nope/train.ts" }, ctx);
  assert.equal(missing.ok, false);
  assert.match(missing.output, /Sugestões de caminho/);
});

test("PowerShell normaliza && e caminho /c/", () => {
  const normalized = normalizePowerShellCommand(
    "cd /c/Users/Administrator/Desktop/repo && git status --short",
  );
  assert.equal(
    normalized.command,
    "Set-Location 'C:/Users/Administrator/Desktop/repo'; git status --short",
  );
  assert.ok(normalized.notes.length >= 2);
});

test("detectVerifyCommands enxerga scripts do package.json", () => {
  const ws = tempWorkspace();
  fs.writeFileSync(
    path.join(ws, "package.json"),
    JSON.stringify({ scripts: { build: "tsc", test: "node --test", lint: "eslint ." } }),
  );
  fs.writeFileSync(path.join(ws, "tsconfig.json"), "{}");
  const commands = detectVerifyCommands(ws);
  assert.ok(commands.includes("npm run build"));
  assert.ok(commands.includes("npm test"));
});

class ScriptedModel implements ModelAdapter {
  id = "mock:scripted";
  private index = 0;
  constructor(private readonly script: string[]) {}

  async complete(_request: ModelRequest): Promise<ModelResponse> {
    const text = this.script[Math.min(this.index, this.script.length - 1)];
    this.index += 1;
    return { text, model: this.id };
  }
}

test("loop executa tool, registra mudança e finaliza", async () => {
  const ws = tempWorkspace();
  const config = defaultConfig(ws);
  config.verify.enabled = false;
  config.limits.maxSteps = 6;
  const model = new ScriptedModel([
    '<tool name="write_file">{"path":"hello.txt","content":"olá"}</tool>',
    "<final>arquivo criado</final>",
  ]);

  const result = await runAgent({ task: "crie hello.txt", config, model });
  assert.equal(result.status, "done");
  assert.match(result.final, /arquivo criado/);
  assert.deepEqual(result.changedFiles, ["hello.txt"]);
  assert.equal(fs.readFileSync(path.join(ws, "hello.txt"), "utf8"), "olá");
  assert.equal(fs.existsSync(result.transcriptPath), true);
});

test("loop respeita maxSteps", async () => {
  const ws = tempWorkspace();
  const config = defaultConfig(ws);
  config.verify.enabled = false;
  config.limits.maxSteps = 2;
  config.limits.maxToolCalls = 10;
  const model = new ScriptedModel([
    '<tool name="list_dir">{"path":"."}</tool>',
  ]);
  const result = await runAgent({ task: "loop", config, model });
  assert.equal(result.status, "max-steps");
});

test("loop interrompe chamadas repetidas", async () => {
  const ws = tempWorkspace();
  const config = defaultConfig(ws);
  config.verify.enabled = false;
  config.limits.maxSteps = 10;
  config.limits.maxToolCalls = 20;
  const model = new ScriptedModel([
    '<tool name="shell">{"command":"echo ok"}</tool>',
  ]);
  const result = await runAgent({ task: "repita", config, model });
  assert.equal(result.status, "error");
  assert.match(result.final, /repetiu a mesma chamada/i);
});

test("loop lê, edita, salva e executa com caminho corrigido", async () => {
  const ws = tempWorkspace();
  const real = path.join(ws, "cli", "mini-gpt", "train.ts");
  fs.mkdirSync(path.dirname(real), { recursive: true });
  fs.writeFileSync(real, "export const value = 1;\n");

  const config = defaultConfig(ws);
  config.verify.enabled = false;
  config.limits.maxSteps = 8;
  config.limits.maxToolCalls = 12;
  const model = new ScriptedModel([
    '<tool name="read_file">{"path":"cli/minigpt/train.ts"}</tool>',
    '<tool name="patch_file">{"path":"cli/minigpt/train.ts","oldString":"value = 1","newString":"value = 2"}</tool>',
    '<tool name="write_file">{"path":"out/result.txt","content":"ok\\n"}</tool>',
    '<tool name="shell">{"command":"Get-Content out/result.txt"}</tool>',
    "<final>lido, editado, salvo e executado</final>",
  ]);

  const result = await runAgent({ task: "edite e teste", config, model });
  assert.equal(result.status, "done");
  assert.match(result.final, /lido, editado, salvo e executado/);
  assert.match(fs.readFileSync(real, "utf8"), /value = 2/);
  assert.equal(fs.readFileSync(path.join(ws, "out", "result.txt"), "utf8"), "ok\n");
  const shellStep = result.steps.find((step) => step.name === "shell");
  assert.ok(shellStep);
  assert.equal(shellStep.ok, true);
  assert.match(shellStep.output ?? "", /ok/);
});

test("extrai arquivos alvo citados na tarefa", () => {
  assert.deepEqual(extractTargetFiles("crie um arquivo chamado teste.ts e rode"), ["teste.ts"]);
  assert.deepEqual(
    extractTargetFiles("corrija apps/agent/src/cli.ts e apps/agent/test/core.test.ts"),
    ["apps/agent/src/cli.ts", "apps/agent/test/core.test.ts"],
  );
});

test("pede o caminho quando a escrita cita 'o arquivo' sem alvo", () => {
  assert.equal(needsTargetClarification("adicione ao arquivo como subir PTY", []), true);
  assert.equal(needsTargetClarification("edite o arquivo atual", []), true);
  assert.equal(needsTargetClarification("crie um arquivo novo", []), false);
  assert.equal(needsTargetClarification("edite teste.ts", ["teste.ts"]), false);
  assert.equal(needsTargetClarification("explique o arquivo", []), false);
});

test("taskPrompt prioriza o arquivo alvo em vez de explorar o repo", () => {
  const prompt = taskPrompt("crie teste.py", undefined, ["teste.py"]);
  assert.match(prompt, /ARQUIVO\(S\) ALVO: teste\.py/);
  assert.match(prompt, /write_file/);
  assert.doesNotMatch(prompt, /Comece inspecionando o reposit/);
});

test("resolveChatTargets mantém o alvo anterior em continuações", () => {
  assert.deepEqual(resolveChatTargets("edite o arquivo para somar", ["teste.py"]), ["teste.py"]);
  assert.deepEqual(resolveChatTargets("crie um arquivo novo", ["teste.py"]), []);
  assert.deepEqual(resolveChatTargets("agora use outro.ts", ["teste.py"]), ["outro.ts"]);
  assert.deepEqual(resolveChatTargets("adicione testes", ["teste.py"]), ["teste.py"]);
});

test("modo alvo injeta conteúdo, esconde ferramentas de exploração e bloqueia glob", async () => {
  const ws = tempWorkspace();
  fs.writeFileSync(path.join(ws, "teste.py"), "print('old')\n");
  const config = defaultConfig(ws);
  config.verify.enabled = false;
  config.limits.maxSteps = 6;
  const requests: ModelRequest[] = [];

  class CaptureModel implements ModelAdapter {
    id = "mock:capture";
    private index = 0;
    constructor(private readonly script: string[]) {}
    async complete(request: ModelRequest): Promise<ModelResponse> {
      requests.push(request);
      const text = this.script[Math.min(this.index, this.script.length - 1)];
      this.index += 1;
      return { text, model: this.id };
    }
  }

  const model = new CaptureModel([
    '<tool name="glob">{"pattern":"*.py","limit":5}</tool>',
    '<tool name="patch_file">{"path":"teste.py","oldString":"print(\'old\')","newString":"print(\'new\')"}</tool>',
    "<final>editado</final>",
  ]);

  const result = await runAgent({
    task: "edite teste.py",
    config,
    model,
    targetFiles: ["teste.py"],
  });

  assert.equal(result.status, "done");
  assert.match(fs.readFileSync(path.join(ws, "teste.py"), "utf8"), /print\('new'\)/);
  const glob = result.steps.find((step) => step.name === "glob");
  assert.equal(glob?.ok, false);
  assert.match(glob?.output ?? "", /ALVO/);

  const firstPrompt = requests[0]?.messages.map((message) => message.content).join("\n") ?? "";
  assert.match(firstPrompt, /CONTEÚDO ATUAL/);
  assert.match(firstPrompt, /print\('old'\)/);
  const toolNames = requests[0]?.tools?.map((tool) => tool.name) ?? [];
  assert.ok(toolNames.includes("write_file"));
  assert.equal(toolNames.includes("glob"), false);
  assert.equal(toolNames.includes("read_file"), false);
});

test("modo alvo finaliza como done depois de alterar o alvo e tentar outro arquivo", async () => {
  const ws = tempWorkspace();
  fs.writeFileSync(path.join(ws, "teste.py"), "print('antigo')\n");
  const config = defaultConfig(ws);
  config.verify.enabled = false;
  config.limits.maxSteps = 6;
  const model = new ScriptedModel([
    '<tool name="patch_file">{"path":"teste.py","oldString":"print(\'antigo\')","newString":"print(\'novo\')"}</tool>',
    '<tool name="write_file">{"path":"outro.py","content":"print(\'errado\')"}</tool>',
    "<final>não deveria chegar</final>",
  ]);

  const result = await runAgent({
    task: "edite teste.py",
    config,
    model,
    targetFiles: ["teste.py"],
  });

  assert.equal(result.status, "done");
  assert.match(fs.readFileSync(path.join(ws, "teste.py"), "utf8"), /print\('novo'\)/);
  assert.equal(fs.existsSync(path.join(ws, "outro.py")), false);
  assert.match(result.final, /alvo já alterado/i);
});

test("modo alvo finaliza quando o patch repetido já está aplicado", async () => {
  const ws = tempWorkspace();
  fs.writeFileSync(path.join(ws, "teste.py"), "print('antigo')\n");
  const config = defaultConfig(ws);
  config.verify.enabled = false;
  config.limits.maxSteps = 5;
  const model = new ScriptedModel([
    '<tool name="patch_file">{"path":"teste.py","oldString":"print(\'antigo\')","newString":"print(\'novo\')"}</tool>',
    '<tool name="patch_file">{"path":"teste.py","oldString":"print(\'antigo\')","newString":"print(\'novo\')"}</tool>',
    "<final>não deveria chegar</final>",
  ]);

  const result = await runAgent({
    task: "edite teste.py",
    config,
    model,
    targetFiles: ["teste.py"],
  });

  assert.equal(result.status, "done");
  assert.match(result.final, /já contém a alteração/i);
  assert.equal(fs.readFileSync(path.join(ws, "teste.py"), "utf8"), "print('novo')\n");
});

test("modo alvo pede escrita antes de aceitar final falso", async () => {
  const ws = tempWorkspace();
  const config = defaultConfig(ws);
  config.verify.enabled = false;
  config.limits.maxSteps = 6;
  const model = new ScriptedModel([
    "<final>Realizei a edição. A alteração foi feita e o arquivo está com o conteúdo esperado.</final>",
    '<tool name="write_file">{"path":"teste.py","content":"print(\'ok\')\\n"}</tool>',
    "<final>arquivo criado</final>",
  ]);

  const result = await runAgent({
    task: "crie teste.py com print('ok')",
    config,
    model,
    targetFiles: ["teste.py"],
  });

  assert.equal(result.status, "done");
  assert.equal(fs.readFileSync(path.join(ws, "teste.py"), "utf8"), "print('ok')\n");
  assert.ok(result.steps.some((step) => step.name === "mock:scripted:forced-write"));
});

test("modo alvo converte leitura repetida em escrita focada", async () => {
  const ws = tempWorkspace();
  const config = defaultConfig(ws);
  config.verify.enabled = false;
  config.limits.maxSteps = 5;
  const model = new ScriptedModel([
    '<tool name="read_file">{"path":"teste.py"}</tool>',
    '<tool name="write_file">{"path":"teste.py","content":"print(\'ok\')\\n"}</tool>',
    "<final>criado</final>",
  ]);

  const result = await runAgent({
    task: "crie teste.py com print('ok')",
    config,
    model,
    targetFiles: ["teste.py"],
  });

  assert.equal(result.status, "done");
  assert.equal(fs.readFileSync(path.join(ws, "teste.py"), "utf8"), "print('ok')\n");
  assert.ok(result.steps.some((step) => step.name === "mock:scripted:forced-write"));
  assert.equal(result.steps.some((step) => step.name === "loop-guard"), false);
});

test("modo alvo troca patch com oldString errado por write_file focado", async () => {
  const ws = tempWorkspace();
  fs.writeFileSync(path.join(ws, "teste.py"), "#\n");
  const config = defaultConfig(ws);
  config.verify.enabled = false;
  config.limits.maxSteps = 5;
  const model = new ScriptedModel([
    '<tool name="patch_file">{"path":"teste.py","oldString":"#\\n\\n","newString":"print(\'novo\')\\n"}</tool>',
    '<tool name="write_file">{"path":"teste.py","content":"print(\'novo\')\\n"}</tool>',
    "<final>editado</final>",
  ]);

  const result = await runAgent({
    task: "edite teste.py para imprimir 'novo'",
    config,
    model,
    targetFiles: ["teste.py"],
  });

  assert.equal(result.status, "done");
  assert.equal(fs.readFileSync(path.join(ws, "teste.py"), "utf8"), "print('novo')\n");
  assert.ok(result.steps.some((step) => step.name === "mock:scripted:forced-write"));
});

test("modo alvo redireciona escrita no caminho errado para o alvo exato", async () => {
  const ws = tempWorkspace();
  fs.writeFileSync(path.join(ws, "teste.py"), "#\n");
  const config = defaultConfig(ws);
  config.verify.enabled = false;
  config.limits.maxSteps = 5;
  const model = new ScriptedModel([
    '<tool name="write_file">{"path":"apps/agent/src/teste.py","content":"print(\'novo\')\\n"}</tool>',
    '<tool name="write_file">{"path":"teste.py","content":"print(\'novo\')\\n"}</tool>',
    "<final>editado</final>",
  ]);

  const result = await runAgent({
    task: "edite teste.py para imprimir 'novo'",
    config,
    model,
    targetFiles: ["teste.py"],
  });

  assert.equal(result.status, "done");
  assert.equal(fs.readFileSync(path.join(ws, "teste.py"), "utf8"), "print('novo')\n");
  assert.equal(fs.existsSync(path.join(ws, "apps", "agent", "src", "teste.py")), false);
  assert.ok(result.steps.some((step) => step.name === "mock:scripted:forced-write"));
});

test("modo alvo falha quando o modelo insiste em final falso sem escrever", async () => {
  const ws = tempWorkspace();
  const config = defaultConfig(ws);
  config.verify.enabled = false;
  config.limits.maxSteps = 4;
  const model = new ScriptedModel([
    "<final>Realizei a edição. A alteração foi feita e o arquivo está com o conteúdo esperado.</final>",
  ]);

  const result = await runAgent({
    task: "crie teste.py com print('ok')",
    config,
    model,
    targetFiles: ["teste.py"],
  });

  assert.equal(result.status, "error");
  assert.match(result.final, /\[AVISO\] Nenhum arquivo foi criado ou alterado/);
  assert.equal(fs.existsSync(path.join(ws, "teste.py")), false);
});

test("modo alvo reconhece 'comece implementacao' como intenção de escrita", async () => {
  const ws = tempWorkspace();
  const config = defaultConfig(ws);
  config.verify.enabled = false;
  config.limits.maxSteps = 4;
  const model = new ScriptedModel([
    "<final>Arquivo não contém código funcional; o conteúdo foi atualizado.</final>",
    '<tool name="write_file">{"path":"teste.py","content":"print(\'novo\')\\n"}</tool>',
    "<final>implementado</final>",
  ]);

  const result = await runAgent({
    task: "no arquivo teste.py comece implementacao de um esboco",
    config,
    model,
    targetFiles: ["teste.py"],
  });

  assert.equal(result.status, "done");
  assert.equal(fs.readFileSync(path.join(ws, "teste.py"), "utf8"), "print('novo')\n");
  assert.ok(result.steps.some((step) => step.name === "mock:scripted:forced-write"));
});

test("loop remove tool de exploração repetida e continua", async () => {
  const ws = tempWorkspace();
  fs.writeFileSync(path.join(ws, "a.txt"), "ok");
  const config = defaultConfig(ws);
  config.verify.enabled = false;
  config.limits.maxSteps = 6;
  const model = new ScriptedModel([
    '<tool name="list_dir">{"path":"."}</tool>',
    '<tool name="list_dir">{"path":"."}</tool>',
    '<tool name="list_dir">{"path":"."}</tool>',
    '<tool name="list_dir">{"path":"."}</tool>',
    "<final>analisado</final>",
  ]);

  const result = await runAgent({ task: "analise o diretorio", config, model });

  assert.equal(result.status, "done");
  assert.ok(result.steps.some((step) => step.name === "tool-adjust"));
  assert.ok(result.steps.some((step) => step.name === "list_dir" && /TOOL DESATIVADA/.test(step.output ?? "")));
  assert.equal(result.steps.some((step) => step.name === "loop-guard"), false);
});

test("loop bloqueia escrita fora do arquivo alvo", async () => {
  const ws = tempWorkspace();
  const config = defaultConfig(ws);
  config.verify.enabled = false;
  config.limits.maxSteps = 6;
  const model = new ScriptedModel([
    '<tool name="write_file">{"path":"outro.ts","content":"export const errado = true;\\n"}</tool>',
    '<tool name="write_file">{"path":"teste.ts","content":"export function soma(a: number, b: number) { return a + b; }\\n"}</tool>',
    "<final>alvo criado</final>",
  ]);

  const result = await runAgent({
    task: "crie teste.ts",
    config,
    model,
    targetFiles: ["teste.ts"],
  });

  assert.equal(result.status, "done");
  assert.equal(fs.existsSync(path.join(ws, "outro.ts")), false);
  assert.equal(fs.existsSync(path.join(ws, "teste.ts")), true);
  const writes = result.steps.filter((step) => step.name === "write_file");
  assert.equal(writes[0]?.ok, false);
  assert.match(writes[0]?.output ?? "", /ALVO BLOQUEADO/);
  assert.equal(writes[1]?.ok, true);
});

test("loop bloqueia escrita idêntica repetida no mesmo arquivo", async () => {
  const ws = tempWorkspace();
  const config = defaultConfig(ws);
  config.verify.enabled = false;
  config.limits.maxSteps = 5;
  const model = new ScriptedModel([
    '<tool name="write_file">{"path":"teste.ts","content":"export const ok = true;\\n"}</tool>',
    '<tool name="write_file">{"path":"teste.ts","content":"export const ok = true;\\n"}</tool>',
    "<final>arquivo criado</final>",
  ]);

  const result = await runAgent({ task: "crie teste.ts", config, model, targetFiles: ["teste.ts"] });

  assert.equal(result.status, "done");
  const writes = result.steps.filter((step) => step.name === "write_file");
  assert.equal(writes[0]?.ok, true);
  assert.equal(writes[1]?.ok, false);
  assert.match(writes[1]?.output ?? "", /REPETIDO/);
});

test("loop bloqueia arquivo novo sem alvo explícito", async () => {
  const ws = tempWorkspace();
  const config = defaultConfig(ws);
  config.verify.enabled = false;
  config.limits.maxSteps = 4;
  const model = new ScriptedModel([
    '<tool name="write_file">{"path":"src/core/protocol.ts","content":"// teste\\n"}</tool>',
    "<final>nada criado</final>",
  ]);

  const result = await runAgent({ task: "crie um arquivo para configurar algo", config, model, targetFiles: [] });

  assert.equal(result.status, "done");
  assert.equal(fs.existsSync(path.join(ws, "src/core/protocol.ts")), false);
  const write = result.steps.find((step) => step.name === "write_file");
  assert.equal(write?.ok, false);
  assert.match(write?.output ?? "", /NOVO ARQUIVO BLOQUEADO/);
});

test("loop avisa quando o modelo alega escrita sem alterar arquivo", async () => {
  const ws = tempWorkspace();
  const config = defaultConfig(ws);
  config.verify.enabled = false;
  config.limits.maxSteps = 4;
  const model = new ScriptedModel([
    '<tool name="write_file">{"path":"src/core/protocol.ts","content":"// x\\n"}</tool>',
    "<final>Criei o arquivo e implementei tudo.</final>",
  ]);

  const result = await runAgent({ task: "crie um arquivo para configurar algo", config, model, targetFiles: [] });

  assert.equal(result.status, "error");
  assert.match(result.final, /\[AVISO\] Nenhum arquivo foi criado ou alterado/);
  assert.deepEqual(result.changedFiles, []);
});
