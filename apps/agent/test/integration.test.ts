/**
 * Testes de integração entre o loop e os adapters de modelo.
 *
 * O adapter local usa um checkpoint minúsculo salvo em disco; o adapter HTTP
 * usa `fetch` mockado, sem rede real.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultConfig } from "../src/core/config.ts";
import { runAgent } from "../src/core/loop.ts";
import type { ModelRequest } from "../src/core/types.ts";
import { BpeTokenizer } from "../src/model/bpe.ts";
import { GptModel } from "../src/model/gpt.ts";
import { HttpModelAdapter } from "../src/model/http.ts";
import { LocalModelAdapter } from "../src/model/local.ts";

const corpus = [
  "export function add(a: number, b: number): number { return a + b; }",
  "### USER\ncrie uma funcao\n### ASSISTANT\nfunction f() { return 1; }",
].join("\n").repeat(30);

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("LocalModelAdapter carrega checkpoint e completa dentro do contexto", async () => {
  const dir = tempDir("m5-local-adapter-");
  const file = path.join(dir, "tiny.bin");
  const tokenizer = BpeTokenizer.train(corpus, { vocabSize: 300, sampleChars: 2_000 });
  const model = new GptModel(
    { vocabSize: 320, dModel: 16, nLayer: 1, nHead: 2, dFfn: 32, ctx: 16, eps: 1e-5 },
    5,
  );
  model.save(file, tokenizer);

  const adapter = LocalModelAdapter.load(file, "tiny");
  assert.equal(adapter.id, "local:tiny");
  assert.ok(adapter.contextSize >= 8);

  const response = await adapter.complete({
    messages: [
      { role: "system", content: "Você é um agente." },
      { role: "user", content: "escreva uma função" },
    ],
    maxTokens: 5,
    temperature: 0,
  });
  assert.equal(typeof response.text, "string");
  assert.ok(response.text.length > 0);
  assert.equal(response.model, "local:tiny");
  assert.ok((response.usage?.prompt ?? 0) > 0);
  assert.ok((response.usage?.completion ?? 0) > 0);
});

test("HttpModelAdapter envia contrato OpenAI-compatible", async () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(input),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "<final>ok</final>" } }],
        usage: { prompt_tokens: 12, completion_tokens: 3 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    const adapter = new HttpModelAdapter({ baseUrl: "http://localhost:9/v1/", model: "test-model" });
    const request: ModelRequest = {
      messages: [{ role: "user", content: "oi" }],
      maxTokens: 64,
      temperature: 0.2,
    };
    const response = await adapter.complete(request);
    assert.equal(response.text, "<final>ok</final>");
    assert.deepEqual(response.usage, { prompt: 12, completion: 3 });
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.url, "http://localhost:9/v1/chat/completions");
    assert.equal(requests[0]?.body.model, "test-model");
    assert.equal(requests[0]?.body.max_tokens, 64);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("loop integra com adapter HTTP mockado e finaliza", async () => {
  const ws = tempDir("m5-http-loop-");
  const config = defaultConfig(ws);
  config.verify.enabled = false;
  config.limits.maxSteps = 3;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ choices: [{ message: { content: "<final>tarefa concluída</final>" } }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;

  try {
    const model = new HttpModelAdapter({ baseUrl: "http://localhost:9/v1", model: "mock" });
    const result = await runAgent({ task: "responda", config, model });
    assert.equal(result.status, "done");
    assert.match(result.final, /tarefa concluída/);
    assert.equal(fs.existsSync(result.transcriptPath), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
