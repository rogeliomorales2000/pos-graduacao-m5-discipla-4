/**
 * Testes de integração das tools de índice no workspace.
 *
 * O índice é construído automaticamente na primeira tool que precisa dele e
 * reaproveitado nas chamadas seguintes.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultConfig } from "../src/core/config.ts";
import { Policy } from "../src/core/policy.ts";
import {
  findSymbolsTool,
  indexBuildTool,
  repoMapTool,
  searchCodeTool,
} from "../src/tools/index.ts";

function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "m5-index-tools-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "src", "math.ts"),
    [
      "export interface Point { x: number; y: number; }",
      "export function fibonacci(n: number): number {",
      "  if (n <= 1) return n;",
      "  return fibonacci(n - 1) + fibonacci(n - 2);",
      "}",
      "export class Calculator {",
      "  add(a: number, b: number): number { return a + b; }",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  fs.writeFileSync(
    path.join(root, "app.py"),
    [
      "def greet(name: str) -> str:",
      "    return f'hello {name}'",
      "",
      "class Service:",
      "    def run(self) -> None:",
      "        print(greet('world'))",
      "",
    ].join("\n"),
    "utf8",
  );
  return root;
}

function context(root: string) {
  const config = defaultConfig(root);
  return {
    workspace: root,
    sessionId: "test",
    config,
    policy: new Policy(config),
    log: () => undefined,
  };
}

test("repo_map constrói o índice e lista arquivos e símbolos", async () => {
  const root = workspace();
  const ctx = context(root);
  const result = await repoMapTool.run({}, ctx);
  assert.equal(result.ok, true);
  assert.match(result.output, /math\.ts/);
  assert.match(result.output, /app\.py/);
  assert.match(result.output, /fibonacci/);
  assert.equal(fs.existsSync(path.join(root, ".m5", "code-index.json")), true);
});

test("search_code encontra trechos por termo", async () => {
  const root = workspace();
  const ctx = context(root);
  const result = await searchCodeTool.run({ query: "fibonacci recursion", limit: 5 }, ctx);
  assert.equal(result.ok, true);
  assert.match(result.output, /src\/math\.ts/);
  assert.match(result.output, /fibonacci/);
  assert.equal(result.meta?.hits !== undefined, true);
});

test("search_code aceita filtros de linguagem e caminho", async () => {
  const root = workspace();
  const ctx = context(root);
  const byLanguage = await searchCodeTool.run({ query: "greet", lang: "py" }, ctx);
  assert.match(byLanguage.output, /app\.py/);
  assert.doesNotMatch(byLanguage.output, /math\.ts/);

  const byPath = await searchCodeTool.run({ query: "calculator", path: "src/" }, ctx);
  assert.match(byPath.output, /src\/math\.ts/);
});

test("find_symbols localiza definições exatas e parciais", async () => {
  const root = workspace();
  const ctx = context(root);
  const exact = await findSymbolsTool.run({ name: "fibonacci" }, ctx);
  assert.equal(exact.ok, true);
  assert.match(exact.output, /src\/math\.ts:\d+/);
  assert.match(exact.output, /fibonacci/);

  const partial = await findSymbolsTool.run({ name: "calc" }, ctx);
  assert.match(partial.output, /Calculator/);
});

test("index_build reconstrói e devolve estatísticas", async () => {
  const root = workspace();
  const ctx = context(root);
  const result = await indexBuildTool.run({}, ctx);
  assert.equal(result.ok, true);
  assert.match(result.output, /arquivos=2/);
  assert.match(result.output, /linguagens:/);
  assert.match(result.output, /ts=/);
  assert.match(result.output, /py=/);
  assert.equal(result.meta?.files, 2);
});

test("tool sem query/nome falha com mensagem clara", async () => {
  const root = workspace();
  const ctx = context(root);
  const searchResult = await searchCodeTool.run({}, ctx);
  assert.equal(searchResult.ok, false);
  assert.match(searchResult.output, /query/);
  const symbolResult = await findSymbolsTool.run({}, ctx);
  assert.equal(symbolResult.ok, false);
  assert.match(symbolResult.output, /name/);
});
