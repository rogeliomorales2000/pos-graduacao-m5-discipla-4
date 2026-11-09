import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BpeTokenizer } from "../src/model/bpe";
import { loadCorpus } from "../src/model/corpus";
import { GptConfig, GptModel } from "../src/model/gpt";

const corpus = [
  "export function add(a: number, b: number): number { return a + b; }",
  "def soma(a, b): return a + b",
  "int main(void) { return 0; }",
  "### USER\ncrie uma funcao\n### ASSISTANT\nfunction f() { return 1; }",
].join("\n").repeat(20);

test("BPE treina, codifica e decodifica sem perda", () => {
  const tokenizer = BpeTokenizer.train(corpus, { vocabSize: 400, sampleChars: 5_000, minFrequency: 2 });
  assert.ok(tokenizer.vocabSize > 260);
  const text = "export function soma(a: number) { return a; }";
  const ids = tokenizer.encode(text);
  assert.ok(ids.length > 0);
  assert.equal(tokenizer.decode(ids), text);

  const reloaded = new BpeTokenizer(tokenizer.toJSON());
  assert.deepEqual(reloaded.encode(text), ids);
  assert.equal(reloaded.decode(ids), text);
});

function lossOf(model: GptModel, ids: number[], targets: number[]): number {
  const cache = model.forward(ids);
  const V = model.config.vocabSize;
  let loss = 0;
  for (let t = 0; t < targets.length; t++) {
    const row = cache.logits.subarray(t * V, t * V + V);
    let max = -Infinity;
    for (let i = 0; i < V; i++) max = Math.max(max, row[i]);
    let sum = 0;
    for (let i = 0; i < V; i++) sum += Math.exp(row[i] - max);
    const logProb = row[targets[t]] - max - Math.log(sum);
    loss += -logProb;
  }
  return loss / targets.length;
}

function tinyConfig(vocabSize: number): GptConfig {
  return { vocabSize, dModel: 16, nLayer: 1, nHead: 2, dFfn: 32, ctx: 8, eps: 1e-5 };
}

test("backward bate com gradiente numérico", () => {
  const model = new GptModel(tinyConfig(40), 7);
  const ids = [5, 9, 12, 20, 30];
  const targets = [9, 12, 20, 30, 11];

  model.zeroGrad();
  const cache = model.forward(ids);
  model.backward(cache, targets);

  const check = (name: string, index: number): void => {
    const param = model.p.get(name)!;
    const grad = model.g.get(name)!;
    const original = param[index];
    const eps = 1e-3;
    param[index] = original + eps;
    const plus = lossOf(model, ids, targets);
    param[index] = original - eps;
    const minus = lossOf(model, ids, targets);
    param[index] = original;
    const numeric = (plus - minus) / (2 * eps);
    const analytic = grad[index];
    const diff = Math.abs(numeric - analytic);
    assert.ok(
      diff < 2e-2,
      `${name}[${index}] numeric=${numeric.toFixed(6)} analytic=${analytic.toFixed(6)} diff=${diff.toFixed(6)}`,
    );
  };

  check("wte", 5 * 16 + 3);
  check("wpe", 2 * 16 + 7);
  check("l0.wqkv", 11);
  check("l0.wo", 3);
  check("l0.fc1", 27);
  check("l0.fc2", 41);
  check("lnfg", 4);
});

test("treino reduz loss e checkpoint preserva logits", () => {
  const model = new GptModel(tinyConfig(40), 11);
  const ids = [5, 9, 12, 20, 30, 6, 7];
  const targets = ids.slice(1).concat([8]);

  const before = lossOf(model, ids, targets);
  for (let step = 0; step < 60; step++) {
    model.zeroGrad();
    const cache = model.forward(ids);
    model.backward(cache, targets);
    model.step(0.01);
  }
  const after = lossOf(model, ids, targets);
  assert.ok(after < before, `loss deveria cair: ${before} -> ${after}`);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m5-gpt-"));
  const file = path.join(dir, "checkpoint.bin");
  const tokenizer = BpeTokenizer.train(corpus, { vocabSize: 300, sampleChars: 2_000 });
  model.save(file, tokenizer);

  const loaded = GptModel.load(file);
  assert.equal(loaded.model.config.dModel, model.config.dModel);
  assert.equal(loaded.model.numParams(), model.numParams());

  const a = model.forward(ids).logits;
  const b = loaded.model.forward(ids).logits;
  for (let i = 0; i < a.length; i += 97) {
    assert.ok(Math.abs(a[i] - b[i]) < 1e-5, `logit ${i} divergiu`);
  }
});

test("generate respeita maxNewTokens e temperatura 0 é determinístico", () => {
  const model = new GptModel(tinyConfig(40), 3);
  const a = model.generate([1, 2, 3], { maxNewTokens: 5, temperature: 0 });
  const b = model.generate([1, 2, 3], { maxNewTokens: 5, temperature: 0 });
  assert.equal(a.length, 8);
  assert.deepEqual(a, b);
});

test("loadCorpus ignora all e distribui o orçamento entre todas as linguagens", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m5-corpus-"));
  try {
    const languages = ["ts", "py", "c", "cpp", "sh", "ps1", "php", "sql", "x86", "arm64", "java", "cs", "rust", "go"];
    const row = JSON.stringify({ instruction: "tarefa", output: "codigo" }) + "\n";
    for (const language of languages) {
      fs.mkdirSync(path.join(dir, language), { recursive: true });
      fs.writeFileSync(path.join(dir, language, "train.jsonl"), row.repeat(2));
    }
    fs.mkdirSync(path.join(dir, "all"), { recursive: true });
    fs.writeFileSync(path.join(dir, "all", "train.jsonl"), row.repeat(5));

    const full = loadCorpus(dir, 1_000_000);
    assert.equal(full.files, languages.length);
    assert.equal(full.samples, languages.length * 2, "all não deve ser contado como linguagem");
    assert.deepEqual(Object.keys(full.languages).sort(), languages.slice().sort());

    const piece = "### USER\ntarefa\n\n### ASSISTANT\ncodigo\n\n";
    const limited = loadCorpus(dir, piece.length * languages.length);
    assert.equal(limited.samples, languages.length, "orçamento limitado deve cobrir 1 amostra por linguagem");
    assert.deepEqual(Object.keys(limited.languages).sort(), languages.slice().sort());

    const onlyAll = fs.mkdtempSync(path.join(os.tmpdir(), "m5-corpus-all-"));
    try {
      fs.mkdirSync(path.join(onlyAll, "all"), { recursive: true });
      fs.writeFileSync(path.join(onlyAll, "all", "train.jsonl"), row.repeat(3));
      const fallback = loadCorpus(onlyAll, 1_000_000);
      assert.equal(fallback.files, 1);
      assert.equal(fallback.samples, 3);
      assert.equal(fallback.languages.all, 3);
    } finally {
      fs.rmSync(onlyAll, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
