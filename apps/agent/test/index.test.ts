/**
 * Testes do indexador.
 *
 * Cria um repositório temporário com fixtures TS/Python/C, valida extração de
 * símbolos, busca, build incremental, persistência, chunking e embeddings.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { chunkFile } from "../src/index/chunk";
import { cosine, embed, lexicalScore, tokenize } from "../src/index/embed";
import { findSymbols, search } from "../src/index/query";
import { renderRepoMap } from "../src/index/repoMap";
import {
  buildIndex,
  defaultStorePath,
  indexStats,
  loadIndex,
  saveIndex,
} from "../src/index/store";
import type { CodeIndex } from "../src/index/types";
import { detectLang, walkRepo } from "../src/index/walk";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "m5-index-"));
const ROOT = path.join(TMP, "repo");

const TRAIN_TS = `export interface TrainOptions {
  epochs: number;
  learningRate: number;
}

export class Trainer {
  private step = 0;

  constructor(private readonly options: TrainOptions) {}

  trainGptBatch(size: number): number {
    this.step += size;
    return this.step;
  }

  reset(): void {
    this.step = 0;
  }
}

export const EPOCHS = 10;

export function trainGpt(model: { weights: number[] }, options: TrainOptions): number {
  let loss = 0;
  for (let epoch = 0; epoch < options.epochs; epoch++) {
    loss += model.weights.length;
  }
  return loss;
}

export type TrainResult = { loss: number };
`;

const DATA_PY = `class Dataset:
    def __init__(self, rows):
        self.rows = rows

    def load_rows(self):
        return self.rows


def load_dataset(path):
    with open(path) as fh:
        return fh.read()
`;

const MATH_C = `#define MAX_SIZE 128

typedef struct {
  int x;
  int y;
} Vec2;

struct Point {
  int x;
  int y;
};

int add(int a, int b) {
  return a + b;
}
`;

function write(relative: string, content: string): void {
  const abs = path.join(ROOT, relative.split("/").join(path.sep));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

write("src/train.ts", TRAIN_TS);
write("lib/data.py", DATA_PY);
write("native/math.c", MATH_C);
write("README.md", "# Fixture\n\nRepositório usado nos testes do indexador.\n");
write("package.json", '{"name":"fixture","private":true}\n');
write(".gitignore", "ignored/\n*.log\n*.skip.ts\n");
write("ignored/secret.ts", "export function secret(): number { return 42; }\n");
write("src/extra.skip.ts", "export const pulado = true;\n");
write("node_modules/pkg/index.js", "module.exports = 1;\n");
write("tmp/debug.log", "não deve entrar\n");

let cached: CodeIndex | null = null;

function getIndex(): CodeIndex {
  if (!cached) cached = buildIndex({ root: ROOT, useCache: false });
  return cached;
}

after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

test("detecta linguagem pela extensão", () => {
  assert.equal(detectLang("a/b/file.ts"), "ts");
  assert.equal(detectLang("comp.tsx"), "tsx");
  assert.equal(detectLang("script.py"), "py");
  assert.equal(detectLang("main.c"), "c");
  assert.equal(detectLang("x.rs"), "rs");
  assert.equal(detectLang("image.png"), null);
  assert.equal(detectLang("bundle.min.js"), null);
  assert.equal(detectLang("sem-extensao"), null);
});

test("walk respeita ignores padrão e .gitignore", () => {
  const files = walkRepo({ root: ROOT });
  const paths = files.map((f) => f.path);

  assert.ok(paths.includes("src/train.ts"), "inclui TS");
  assert.ok(paths.includes("lib/data.py"), "inclui Python");
  assert.ok(paths.includes("native/math.c"), "inclui C");
  assert.ok(paths.includes("README.md"), "inclui Markdown");
  assert.ok(!paths.some((p) => p.startsWith("node_modules/")), "ignora node_modules");
  assert.ok(!paths.some((p) => p.startsWith("ignored/")), "ignora regra do .gitignore");
  assert.ok(!paths.some((p) => p.endsWith(".log")), "ignora *.log");
  assert.ok(!paths.some((p) => p.endsWith(".skip.ts")), "ignora *.skip.ts");
  assert.deepEqual(paths, [...paths].sort((a, b) => a.localeCompare(b)), "ordem determinística");
});

test("extrai símbolos de TS, Python e C", () => {
  const index = getIndex();

  const train = index.files.find((f) => f.path === "src/train.ts");
  assert.ok(train, "indexou src/train.ts");
  const tsNames = train.symbols.map((s) => s.name);
  for (const expected of [
    "TrainOptions",
    "Trainer",
    "constructor",
    "trainGptBatch",
    "reset",
    "EPOCHS",
    "trainGpt",
    "TrainResult",
  ]) {
    assert.ok(tsNames.includes(expected), `símbolo TS ausente: ${expected}`);
  }
  assert.ok(
    train.symbols.some((s) => s.name === "trainGpt" && s.kind === "function"),
    "trainGpt é function",
  );
  assert.ok(
    train.symbols.some((s) => s.name === "Trainer" && s.kind === "class"),
    "Trainer é class",
  );

  const py = index.files.find((f) => f.path === "lib/data.py");
  assert.ok(py, "indexou lib/data.py");
  const pyNames = py.symbols.map((s) => s.name);
  for (const expected of ["Dataset", "__init__", "load_rows", "load_dataset"]) {
    assert.ok(pyNames.includes(expected), `símbolo Python ausente: ${expected}`);
  }
  assert.ok(
    py.symbols.some((s) => s.name === "Dataset" && s.kind === "class"),
    "Dataset é class",
  );
  assert.ok(
    py.symbols.some((s) => s.name === "load_dataset" && s.kind === "function"),
    "load_dataset é function",
  );

  const c = index.files.find((f) => f.path === "native/math.c");
  assert.ok(c, "indexou native/math.c");
  const cNames = c.symbols.map((s) => s.name);
  for (const expected of ["MAX_SIZE", "Vec2", "Point", "add"]) {
    assert.ok(cNames.includes(expected), `símbolo C ausente: ${expected}`);
  }
});

test("busca híbrida encontra o termo e agrupa por arquivo", () => {
  const index = getIndex();
  const hits = search(index, "trainGpt", { limit: 5 });

  assert.ok(hits.length > 0, "teve resultados");
  assert.equal(hits[0]?.path, "src/train.ts");
  assert.ok((hits[0]?.score ?? 0) > 0, "score positivo");
  assert.ok(hits[0]?.snippet.includes("trainGpt"), "snippet contém o termo");
  assert.ok(hits[0]?.symbols.includes("trainGpt"), "hit aponta o símbolo");
  assert.equal(
    new Set(hits.map((h) => `${h.path}:${h.startLine}`)).size,
    hits.length,
    "trechos deduplicados (mesmo arquivo/linha não se repete)",
  );

  const pyHits = search(index, "dataset", { limit: 5 });
  assert.ok(pyHits.some((h) => h.path === "lib/data.py"), "acha Dataset no Python");

  assert.equal(search(index, "trainGpt", { pathPrefix: "lib/" }).length, 0);
  assert.ok(
    search(index, "dataset", { lang: "py" }).every((h) => h.path.endsWith(".py")),
    "filtro de linguagem",
  );
  assert.equal(search(index, "   ").length, 0, "consulta vazia não retorna nada");
});

test("findSymbols procura por nome exato e parcial", () => {
  const index = getIndex();
  const exact = findSymbols(index, "trainGpt");
  assert.ok(exact.length > 0);
  assert.equal(exact[0]?.name, "trainGpt");
  assert.equal(exact[0]?.file, "src/train.ts");

  const partial = findSymbols(index, "train");
  assert.ok(partial.some((s) => s.name === "Trainer"));
  assert.ok(partial.some((s) => s.name === "trainGpt"));
  assert.equal(findSymbols(index, "").length, 0);
});

test("build incremental reusa arquivos pelo hash sha1", () => {
  const first = buildIndex({ root: ROOT, useCache: false });
  assert.equal(first.meta?.reused, 0);
  assert.ok((first.meta?.changed ?? 0) > 0);

  const second = buildIndex({ root: ROOT, previous: first, useCache: false });
  assert.equal(second.meta?.reused, first.files.length);
  assert.equal(second.meta?.changed, 0);
  assert.equal(second.meta?.removed, 0);

  const before = first.files.find((f) => f.path === "src/train.ts");
  const after = second.files.find((f) => f.path === "src/train.ts");
  assert.ok(before && after);
  assert.equal(before.hash, after.hash, "hash estável");
  assert.deepEqual(before.chunks, after.chunks, "chunks reusados");
  assert.deepEqual(
    first.vectors[before.chunks[0]?.id ?? ""],
    second.vectors[after.chunks[0]?.id ?? ""],
    "vetores reusados",
  );

  write("src/train.ts", TRAIN_TS + "\nexport const VERSION = 2;\n");
  const third = buildIndex({ root: ROOT, previous: second, useCache: false });
  assert.equal(third.meta?.changed, 1, "só o arquivo alterado é reindexado");
  assert.equal(third.meta?.reused, second.files.length - 1);
  const changed = third.files.find((f) => f.path === "src/train.ts");
  assert.ok(changed?.symbols.some((s) => s.name === "VERSION"), "novo símbolo extraído");

  // Restaura a fixture para os demais testes.
  write("src/train.ts", TRAIN_TS);
  cached = null;
});

test("saveIndex/loadIndex preservam o índice e as estatísticas", () => {
  const index = getIndex();
  const store = path.join(TMP, "index.json");
  const saved = saveIndex(index, store);
  assert.equal(saved, path.resolve(store));

  const loaded = loadIndex(store);
  assert.ok(loaded, "carregou o índice");
  assert.equal(loaded.files.length, index.files.length);
  assert.equal(loaded.vectorDim, index.vectorDim);

  const fileWithChunks = index.files.find((f) => f.chunks.length > 0);
  assert.ok(fileWithChunks, "existe arquivo com chunks");
  const chunkId = fileWithChunks.chunks[0]?.id ?? "";
  assert.deepEqual(loaded.vectors[chunkId], index.vectors[chunkId]);

  const stats = indexStats(loaded);
  assert.equal(stats.files, index.files.length);
  assert.ok(stats.symbols > 0);
  assert.ok(stats.chunks > 0);
  assert.ok(stats.vectors > 0);
  assert.ok((stats.languages.ts ?? 0) >= 1);

  assert.equal(loadIndex(path.join(TMP, "nao-existe.json")), null);
  assert.equal(defaultStorePath(ROOT), path.join(path.resolve(ROOT), ".m5", "code-index.json"));
});

test("chunking usa overlap, alinha símbolos e respeita maxChars", () => {
  const content = Array.from(
    { length: 120 },
    (_, i) => `const value${i} = ${i};`,
  ).join("\n");

  const chunks = chunkFile("big.ts", content, []);
  assert.ok(chunks.length >= 3, "gerou múltiplos chunks");
  assert.equal(chunks[0]?.startLine, 1);
  assert.ok((chunks[1]?.startLine ?? 0) <= (chunks[0]?.endLine ?? 0), "há overlap");
  assert.ok(chunks.every((c) => c.text.length <= 4000));
  assert.ok(chunks.every((c) => c.startLine >= 1 && c.endLine >= c.startLine));
  assert.ok(chunks.every((c) => c.id === `${c.file}:${c.startLine}-${c.endLine}`));

  const symbols = [
    {
      name: "alvo",
      kind: "function" as const,
      file: "big.ts",
      line: 35,
      signature: "function alvo()",
    },
  ];
  const aligned = chunkFile("big.ts", content, symbols);
  assert.ok(aligned.some((c) => c.startLine === 35), "início alinhado ao símbolo");

  const small = chunkFile("big.ts", content, [], { maxChars: 200 });
  assert.ok(small.length > chunks.length, "maxChars gera mais chunks");
  assert.ok(small.every((c) => c.text.length <= 200));
});

test("embedding é normalizado e cosseno de vetores idênticos é 1", () => {
  const vector = embed("trainGpt model training");
  assert.equal(vector.length, 256);

  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  assert.ok(Math.abs(norm - 1) < 1e-4, `norma ~1 (${norm})`);
  assert.ok(Math.abs(cosine(vector, vector) - 1) < 1e-9);
  assert.equal(cosine([0, 0, 0], [1, 2, 3]), 0);

  const near = cosine(embed("train gpt model"), embed("train gpt training model"));
  const far = cosine(embed("train gpt model"), embed("banana orange fruit"));
  assert.ok(near > far, "textos parecidos ficam mais próximos");

  assert.ok(tokenize("trainGpt").includes("train"));
  assert.ok(tokenize("trainGpt").includes("gpt"));
  assert.ok(tokenize("load_rows").includes("load"));
  assert.ok(lexicalScore("trainGpt", "export function trainGpt(model: Model) {}") > 0);
  assert.equal(lexicalScore("zzzznope", "export function trainGpt(model: Model) {}"), 0);
});

test("repo map contém árvore, arquivos e símbolos principais", () => {
  const map = renderRepoMap(getIndex(), { maxFiles: 100, maxChars: 4000 });
  assert.ok(map.includes("src/"), "mostra diretório");
  assert.ok(map.includes("train.ts"), "mostra arquivo");
  assert.ok(map.includes("lib/"));
  assert.ok(map.includes("data.py"));
  assert.ok(map.includes("trainGpt"), "mostra símbolo");
  assert.ok(map.length <= 4100, "respeita orçamento de caracteres");
});
