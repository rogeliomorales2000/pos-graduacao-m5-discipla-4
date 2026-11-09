#!/usr/bin/env node
/**
 * Gerador do dataset de código multi-linguagem.
 *
 * Uso:
 *   tsx apps/agent/src/datasets/generate.ts [--out dataset/code]
 *     [--per-language 800] [--only ts,py] [--seed 42] [--no-validate] [--quiet]
 *
 * Saída (por linguagem e agregada):
 *   <out>/<lang>/{train,val,test}.jsonl
 *   <out>/all/{train,val,test}.jsonl
 *   <out>/manifest.json
 *
 * Cada linha segue o contrato consumido pelo treino:
 *   { id, language, task, instruction, output, explanation, tags, difficulty }
 */
import fs from "node:fs";
import path from "node:path";
import type { CodeSample } from "./types.ts";
import { validateSamples, type QualityResult } from "./quality.ts";
import { mulberry32, shuffle } from "./combinators.ts";
import { generateAll } from "./registry.ts";

interface Args {
  out: string;
  perLanguage: number;
  only: string[];
  seed: number;
  validate: boolean;
  quiet: boolean;
}

function parseArgs(argv: string[]): Args {
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (!arg.startsWith("--")) continue;
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    if (eq >= 0) {
      flags[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[body] = next;
      i++;
    } else {
      flags[body] = true;
    }
  }

  const string = (name: string, fallback: string): string => {
    const value = flags[name];
    return typeof value === "string" ? value : fallback;
  };
  const number = (name: string, fallback: number): number => {
    const parsed = Number.parseInt(string(name, ""), 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  return {
    out: path.resolve(process.cwd(), string("out", "dataset/code")),
    perLanguage: number("per-language", 800),
    only: string("only", "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
    seed: number("seed", 42),
    validate: flags["no-validate"] !== true,
    quiet: flags.quiet === true,
  };
}

interface Split {
  train: CodeSample[];
  val: CodeSample[];
  test: CodeSample[];
}

function splitSamples(samples: readonly CodeSample[], seed: number, key: string): Split {
  const mixed = shuffle(mulberry32(seed ^ hashString(key)), samples);
  const total = mixed.length;
  if (total < 3) return { train: [...mixed], val: [], test: [] };
  const valSize = Math.max(1, Math.round(total * 0.05));
  const testSize = Math.max(1, Math.round(total * 0.05));
  const trainSize = total - valSize - testSize;
  return {
    train: mixed.slice(0, trainSize),
    val: mixed.slice(trainSize, trainSize + valSize),
    test: mixed.slice(trainSize + valSize),
  };
}

function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function toRow(sample: CodeSample): Record<string, unknown> {
  return {
    id: sample.id,
    language: sample.language,
    task: sample.task,
    instruction: sample.instruction,
    output: sample.code,
    explanation: sample.explanation,
    tags: sample.tags,
    difficulty: sample.difficulty,
  };
}

function writeJsonl(file: string, samples: readonly CodeSample[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = samples.map((sample) => JSON.stringify(toRow(sample))).join("\n");
  fs.writeFileSync(file, `${body}${body ? "\n" : ""}`, "utf8");
}

function writeSplit(dir: string, split: Split): void {
  writeJsonl(path.join(dir, "train.jsonl"), split.train);
  writeJsonl(path.join(dir, "val.jsonl"), split.val);
  writeJsonl(path.join(dir, "test.jsonl"), split.test);
}

function printQuality(result: QualityResult, quiet: boolean): void {
  if (quiet) return;
  console.log(
    `qualidade: ${result.ok ? "ok" : "FALHOU"} | amostras=${result.stats.total} ` +
      `| ids=${result.stats.uniqueIds} | duplicatas=${result.stats.duplicateCodeHashes} ` +
      `| tamanho medio=${result.stats.averageCodeLength}`,
  );
  for (const [language, stats] of Object.entries(result.stats.constructs)) {
    const missing = stats.filter((item) => item.hits < item.required);
    if (missing.length > 0) {
      console.log(`  ${language}: constructos ausentes ${missing.map((item) => item.name).join(", ")}`);
    }
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const generated = generateAll({ perLanguage: args.perLanguage, only: args.only });
  const all: CodeSample[] = generated.flatMap((item) => item.samples);
  const validated: CodeSample[] = generated.flatMap((item) => item.full);

  const quality = validateSamples(validated);
  printQuality(quality, args.quiet);
  if (args.validate && !quality.ok) {
    for (const error of quality.errors.slice(0, 25)) {
      console.error(`- [${error.language}] ${error.kind}: ${error.message} (${error.id})`);
    }
    const extra = quality.errors.length - 25;
    if (extra > 0) console.error(`... e mais ${extra} erro(s)`);
    throw new Error(`dataset inválido: ${quality.errors.length} problema(s)`);
  }

  const manifestLanguages: Array<Record<string, unknown>> = [];
  const allTrain: CodeSample[] = [];
  const allVal: CodeSample[] = [];
  const allTest: CodeSample[] = [];

  for (const language of generated) {
    const split = splitSamples(language.samples, args.seed, language.key);
    const dir = path.join(args.out, language.key);
    writeSplit(dir, split);
    allTrain.push(...split.train);
    allVal.push(...split.val);
    allTest.push(...split.test);
    manifestLanguages.push({
      key: language.key,
      label: language.label,
      total: language.samples.length,
      available: language.full.length,
      train: split.train.length,
      val: split.val.length,
      test: split.test.length,
      capped: language.capped,
    });
    if (!args.quiet) {
      console.log(
        `${language.key.padEnd(12)} ${String(language.samples.length).padStart(4)} amostras ` +
          `(train=${split.train.length} val=${split.val.length} test=${split.test.length})` +
          (language.capped ? " [limitado pelas combinações disponíveis]" : ""),
      );
    }
  }

  writeSplit(path.join(args.out, "all"), { train: allTrain, val: allVal, test: allTest });

  const outputIsFull = generated.every((item) => item.samples.length === item.full.length);

  const manifest = {
    generatedAt: new Date().toISOString(),
    seed: args.seed,
    perLanguage: args.perLanguage,
    languages: manifestLanguages,
    totals: {
      samples: all.length,
      validated: validated.length,
      train: allTrain.length,
      val: allVal.length,
      test: allTest.length,
    },
    quality: {
      scope: outputIsFull ? "output" : "generator-full",
      ok: quality.ok,
      uniqueIds: quality.stats.uniqueIds,
      duplicateCodeHashes: quality.stats.duplicateCodeHashes,
      minCodeLength: quality.stats.minCodeLength,
      maxCodeLength: quality.stats.maxCodeLength,
      averageCodeLength: quality.stats.averageCodeLength,
    },
  };
  fs.mkdirSync(args.out, { recursive: true });
  fs.writeFileSync(
    path.join(args.out, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );

  if (!args.quiet) {
    console.log(
      `total: ${all.length} amostras em ${generated.length} linguagem(ns) -> ${args.out}`,
    );
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
