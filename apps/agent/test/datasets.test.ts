/**
 * Testes do gerador de dataset multi-linguagem.
 *
 * A validação completa roda sobre todas as amostras: unicidade, tamanho,
 * placeholders, balanceamento e constructos exigidos por linguagem.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { validateSamples } from "../src/datasets/quality.ts";
import {
  LANGUAGES,
  LANGUAGE_KEYS,
  findLanguage,
  generateAll,
} from "../src/datasets/registry.ts";

const REQUIRED_LANGUAGES = [
  "ts",
  "py",
  "c",
  "cpp",
  "sh",
  "ps1",
  "php",
  "sql",
  "asm-x86_64",
  "asm-arm64",
  "java",
  "cs",
  "rust",
  "go",
] as const;

const all = generateAll();

test("registro cobre as 14 linguagens exigidas", () => {
  assert.equal(LANGUAGES.length, 14);
  for (const key of REQUIRED_LANGUAGES) {
    assert.ok(LANGUAGE_KEYS.includes(key), `linguagem ausente: ${key}`);
    assert.ok(findLanguage(key), `gerador ausente: ${key}`);
  }
});

test("cada linguagem produz pelo menos 800 amostras", () => {
  for (const language of all) {
    assert.ok(
      language.samples.length >= 800,
      `${language.key}: apenas ${language.samples.length} amostras`,
    );
    assert.equal(language.capped, false, `${language.key} não deveria estar limitado`);
  }
});

test("ids e códigos são únicos e campos obrigatórios estão preenchidos", () => {
  const ids = new Set<string>();
  const codes = new Set<string>();
  for (const language of all) {
    for (const sample of language.samples) {
      assert.equal(typeof sample.id, "string");
      assert.ok(!ids.has(sample.id), `id duplicado: ${sample.id}`);
      ids.add(sample.id);
      assert.ok(!codes.has(sample.code), `código duplicado em ${sample.id}`);
      codes.add(sample.code);
      assert.equal(sample.language, language.key);
      assert.ok(sample.instruction.length > 20, `${sample.id}: instruction curta`);
      assert.ok(sample.explanation.length > 20, `${sample.id}: explanation curta`);
      assert.ok(sample.code.length >= 120, `${sample.id}: code curto`);
      assert.ok(sample.tags.length >= 5, `${sample.id}: tags insuficientes`);
      assert.ok(
        ["basic", "intermediate", "advanced"].includes(sample.difficulty),
        `${sample.id}: difficulty inválida`,
      );
    }
  }
  assert.equal(ids.size, all.reduce((total, item) => total + item.samples.length, 0));
});

test("validação de qualidade aprova o dataset completo", () => {
  const samples = all.flatMap((item) => item.samples);
  const result = validateSamples(samples);
  if (!result.ok) {
    const details = result.errors
      .slice(0, 10)
      .map((error) => `[${error.language}] ${error.kind}: ${error.message} (${error.id})`)
      .join("\n");
    assert.fail(`qualidade falhou com ${result.errors.length} erro(s):\n${details}`);
  }
  assert.equal(result.stats.total, 14 * 800);
  assert.equal(result.stats.duplicateCodeHashes, 0);
  for (const [, stats] of Object.entries(result.stats.constructs)) {
    for (const construct of stats) {
      assert.ok(
        construct.hits >= construct.required,
        `constructo ${construct.name} insuficiente: ${construct.hits}/${construct.required}`,
      );
    }
  }
});

test("geração é determinística", () => {
  const first = findLanguage("rust")?.generate() ?? [];
  const second = findLanguage("rust")?.generate() ?? [];
  assert.equal(first.length, second.length);
  for (let i = 0; i < Math.min(20, first.length); i++) {
    assert.equal(first[i]?.id, second[i]?.id);
    assert.equal(first[i]?.code, second[i]?.code);
  }
});

test("perLanguage limita a saída por linguagem", () => {
  const limited = generateAll({ perLanguage: 12, only: ["go", "java"] });
  assert.equal(limited.length, 2);
  for (const language of limited) {
    assert.equal(language.samples.length, 12);
    assert.equal(language.requested, 12);
    assert.equal(language.capped, false);
  }
});

test("linguagem desconhecida falha com mensagem útil", () => {
  assert.throws(() => generateAll({ only: ["cobol"] }), /unknown language "cobol"/);
});
