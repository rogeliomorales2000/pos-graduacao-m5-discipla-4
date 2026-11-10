import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultConfig } from "../src/core/config";
import { isDissatisfied, runAgentWithRetry } from "../src/core/retry";
import { ModelAdapter, ModelRequest, ModelResponse } from "../src/core/types";

function tempWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "m5-agent-retry-"));
}

class ScriptedModel implements ModelAdapter {
  id = "mock:retry-scripted";
  private index = 0;

  constructor(private readonly script: string[]) {}

  async complete(_request: ModelRequest): Promise<ModelResponse> {
    const text = this.script[Math.min(this.index, this.script.length - 1)];
    this.index += 1;
    return { text, model: this.id };
  }
}

test("retry repete tarefa de escrita que terminou done sem alterar o alvo", async () => {
  const ws = tempWorkspace();
  const config = defaultConfig(ws);
  config.verify.enabled = false;
  config.limits.maxSteps = 6;
  config.limits.maxTaskAttempts = 3;
  const model = new ScriptedModel([
    "<final>Não alterei o arquivo.</final>",
    '<tool name="write_file">{"path":"teste.py","content":"print(\'ok\')\\n"}</tool>',
    "<final>arquivo criado</final>",
  ]);

  const result = await runAgentWithRetry({
    task: "crie teste.py com print('ok')",
    config,
    model,
    attempts: 3,
    targetFiles: ["teste.py"],
  });

  assert.equal(result.status, "done");
  assert.equal(result.attempts, 2);
  assert.deepEqual(result.changedFiles, ["teste.py"]);
  assert.equal(fs.readFileSync(path.join(ws, "teste.py"), "utf8"), "print('ok')\n");
  assert.ok(result.retryReasons.length >= 1);
  assert.ok(result.steps.some((step) => step.name === "retry"));
  assert.match(result.final, /2 tentativa/);
});

test("retry para no limite e devolve erro honesto quando o alvo nunca é alterado", async () => {
  const ws = tempWorkspace();
  const config = defaultConfig(ws);
  config.verify.enabled = false;
  config.limits.maxSteps = 4;
  config.limits.maxTaskAttempts = 3;
  const model = new ScriptedModel([
    "<final>Realizei a edição. A alteração foi feita e o arquivo está com o conteúdo esperado.</final>",
  ]);

  const result = await runAgentWithRetry({
    task: "crie teste.py com print('ok')",
    config,
    model,
    attempts: 3,
    targetFiles: ["teste.py"],
  });

  assert.equal(result.status, "error");
  assert.equal(result.attempts, 3);
  assert.equal(result.retryReasons.length, 2);
  assert.equal(fs.existsSync(path.join(ws, "teste.py")), false);
  assert.match(result.final, /Nenhum arquivo foi criado ou alterado/);
});

test("retry não repete tarefa concluída com escrita válida", async () => {
  const ws = tempWorkspace();
  const config = defaultConfig(ws);
  config.verify.enabled = false;
  config.limits.maxSteps = 6;
  config.limits.maxTaskAttempts = 3;
  const model = new ScriptedModel([
    '<tool name="write_file">{"path":"teste.py","content":"print(\'ok\')\\n"}</tool>',
    "<final>arquivo criado</final>",
  ]);

  const result = await runAgentWithRetry({
    task: "crie teste.py com print('ok')",
    config,
    model,
    attempts: 3,
    targetFiles: ["teste.py"],
  });

  assert.equal(result.status, "done");
  assert.equal(result.attempts, 1);
  assert.deepEqual(result.retryReasons, []);
  assert.equal(fs.readFileSync(path.join(ws, "teste.py"), "utf8"), "print('ok')\n");
});

test("retry usa a intenção do turno atual, não o histórico de escrita", async () => {
  const ws = tempWorkspace();
  fs.writeFileSync(path.join(ws, "teste.py"), "print('ok')\n");
  const config = defaultConfig(ws);
  config.verify.enabled = false;
  config.limits.maxSteps = 4;
  const model = new ScriptedModel(["<final>O arquivo imprime ok.</final>"]);

  const result = await runAgentWithRetry({
    task: [
      "HISTÓRICO (apenas contexto)",
      "USER: crie teste.py",
      "",
      "MENSAGEM ATUAL DO USUÁRIO",
      "explique teste.py",
    ].join("\n"),
    config,
    model,
    attempts: 3,
    retrievalQuery: "explique teste.py",
    targetFiles: ["teste.py"],
  });

  assert.equal(result.status, "done");
  assert.equal(result.attempts, 1);
  assert.deepEqual(result.changedFiles, []);
  assert.equal(fs.readFileSync(path.join(ws, "teste.py"), "utf8"), "print('ok')\n");
});

test("isDissatisfied detecta reclamações sem confundir uma correção nova", () => {
  assert.equal(isDissatisfied("não estou satisfeito"), true);
  assert.equal(isDissatisfied("não é isso, refaça"), true);
  assert.equal(isDissatisfied("não alterou o arquivo"), true);
  assert.equal(isDissatisfied("não ficou bom"), true);
  assert.equal(isDissatisfied("corrija o bug no arquivo teste.ts"), false);
  assert.equal(isDissatisfied("crie um arquivo novo"), false);
});
