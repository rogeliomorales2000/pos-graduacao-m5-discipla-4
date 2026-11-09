/**
 * Validação de qualidade do dataset de código.
 *
 * As checagens são deliberadamente conservadoras: qualquer amostra suspeita
 * falha o pipeline em vez de contaminar o treino.
 */
import crypto from "node:crypto";
import type { CodeSample } from "./types.ts";
import { balancedBraces } from "./combinators.ts";

export interface QualityIssue {
  id: string;
  language: string;
  kind:
    | "duplicate-id"
    | "duplicate-code"
    | "short-code"
    | "placeholder"
    | "unbalanced"
    | "missing-construct"
    | "invalid-field";
  message: string;
}

export interface ConstructStat {
  name: string;
  hits: number;
  required: number;
}

export interface QualityStats {
  total: number;
  byLanguage: Record<string, number>;
  uniqueIds: number;
  duplicateCodeHashes: number;
  minCodeLength: number;
  maxCodeLength: number;
  averageCodeLength: number;
  constructs: Record<string, ConstructStat[]>;
}

export interface QualityResult {
  ok: boolean;
  errors: QualityIssue[];
  stats: QualityStats;
}

const MIN_CODE_LENGTH = 120;

const PLACEHOLDER_PATTERNS: ReadonlyArray<RegExp> = [
  /\bTODO\b/,
  /\bFIXME\b/,
  /your code here/i,
  /seu c[oó]digo aqui/i,
  /implemente aqui/i,
  /<your[-_ ]/i,
  /^\s*\.\.\.\s*$/m,
  /^\s*(?:\/\/|#|--|;)\s*\.\.\.\s*$/m,
];

interface CleanConfig {
  lineComments: string[];
  blockComments: Array<readonly [string, string]>;
  quotes: string[];
  tripleQuotes?: boolean;
  hashNeedsBoundary?: boolean;
}

const C_LIKE: CleanConfig = {
  lineComments: ["//"],
  blockComments: [["/*", "*/"]],
  quotes: ['"', "'", "`"],
};

const CLEANERS: Record<string, CleanConfig> = {
  ts: C_LIKE,
  js: C_LIKE,
  c: C_LIKE,
  cpp: C_LIKE,
  java: C_LIKE,
  cs: C_LIKE,
  rust: { ...C_LIKE, quotes: ['"'] },
  go: C_LIKE,
  php: { ...C_LIKE, lineComments: ["//", "#"] },
  py: { lineComments: ["#"], blockComments: [], quotes: ['"', "'"], tripleQuotes: true },
  sh: {
    lineComments: ["#"],
    blockComments: [],
    quotes: ['"', "'", "`"],
    hashNeedsBoundary: true,
  },
  ps1: {
    lineComments: ["#"],
    blockComments: [["<#", "#>"]],
    quotes: ['"', "'"],
    hashNeedsBoundary: true,
  },
  sql: {
    lineComments: ["--"],
    blockComments: [["/*", "*/"]],
    quotes: ['"', "'"],
  },
  "asm-x86_64": { lineComments: ["#", ";"], blockComments: [], quotes: ['"', "'"] },
  "asm-arm64": { lineComments: ["//"], blockComments: [], quotes: ['"'] },
};

function startsWithAt(text: string, index: number, token: string): boolean {
  return text.startsWith(token, index);
}

function isHashBoundary(text: string, index: number): boolean {
  if (index === 0) return true;
  const previous = text[index - 1] as string;
  return previous === "\n" || /\s/.test(previous) || previous === ";" || previous === "|";
}

/**
 * Remove strings e comentários para que a checagem de delimitadores não seja
 * confundida por chaves literais. Preserva novas linhas para manter a forma.
 */
export function stripNonCode(code: string, language: string): string {
  const config = CLEANERS[language] ?? C_LIKE;
  let out = "";
  let i = 0;
  while (i < code.length) {
    const ch = code[i] as string;
    const rest = code.slice(i);

    const block = config.blockComments.find(([open]) => startsWithAt(code, i, open));
    if (block) {
      const [open, close] = block;
      const end = code.indexOf(close, i + open.length);
      const swallowed = end === -1 ? rest : code.slice(i, end + close.length);
      out += swallowed.replace(/[^\n]/g, "");
      i = end === -1 ? code.length : end + close.length;
      continue;
    }

    let matchedLineComment = false;
    for (const marker of config.lineComments) {
      if (!startsWithAt(code, i, marker)) continue;
      if (marker === "#" && config.hashNeedsBoundary && !isHashBoundary(code, i)) continue;
      const end = code.indexOf("\n", i + marker.length);
      i = end === -1 ? code.length : end;
      matchedLineComment = true;
      break;
    }
    if (matchedLineComment) continue;

    if (config.quotes.includes(ch)) {
      const triple = config.tripleQuotes === true && code.slice(i, i + 3) === ch.repeat(3);
      const delimiter = triple ? ch.repeat(3) : ch;
      let j = i + delimiter.length;
      while (j < code.length) {
        if (code[j] === "\\") {
          j += 2;
          continue;
        }
        if (code.startsWith(delimiter, j)) break;
        j += 1;
      }
      out += delimiter.length === 3 ? "" : "";
      i = j >= code.length ? code.length : j + delimiter.length;
      continue;
    }

    out += ch;
    i += 1;
  }
  return out;
}

interface ConstructSpec {
  name: string;
  pattern: RegExp;
  required?: number;
}

const INTERMEDIATE = 1;

const CONSTRUCTS: Record<string, ConstructSpec[]> = {
  ts: [
    { name: "interface", pattern: /\binterface\s+\w+/ },
    { name: "generics", pattern: /\b(function|class)\s+\w+</ },
    { name: "async", pattern: /\b(async|await|Promise)\b/ },
    { name: "class", pattern: /\bclass\s+\w+/ },
    { name: "node-test", pattern: /node:test/ },
    { name: "type-guard", pattern: /\bis\s+Extract<|\bkind:\s*"/ },
  ],
  py: [
    { name: "dataclass", pattern: /@dataclass/ },
    { name: "generator", pattern: /\byield\b/ },
    { name: "argparse", pattern: /argparse/ },
    { name: "asyncio", pattern: /asyncio/ },
    { name: "unittest", pattern: /unittest/ },
    { name: "type-hints", pattern: /->\s*[A-Za-z_]/ },
    { name: "context-manager", pattern: /@contextmanager/ },
  ],
  c: [
    { name: "stdio", pattern: /#include\s*<stdio\.h>/ },
    { name: "malloc-free", pattern: /malloc\(/ },
    { name: "free", pattern: /free\(/ },
    { name: "struct", pattern: /\bstruct\s+\w+/ },
    { name: "pointer-loop", pattern: /for\s*\(/ },
    { name: "fixed-width", pattern: /\b(uint32_t|uint64_t|size_t|int64_t)\b/ },
  ],
  cpp: [
    { name: "headers", pattern: /#include\s*</ },
    { name: "std-library", pattern: /std::/ },
    { name: "template", pattern: /\btemplate\s*</ },
    { name: "raii", pattern: /\b(class|struct)\s+\w+/ },
    { name: "smart-pointer", pattern: /\b(unique_ptr|shared_ptr)\b/ },
    { name: "containers", pattern: /\b(vector|map|unordered_map|optional|variant|string)\b/ },
  ],
  sh: [
    { name: "strict-mode", pattern: /set -euo pipefail/ },
    { name: "unix-tools", pattern: /\b(awk|sed|find|xargs)\b/ },
    { name: "variables", pattern: /\$\{?\w+\}?/ },
    { name: "loops", pattern: /\bfor\s+\w+\s+in\b/ },
    { name: "trap-or-getopts", pattern: /\btrap\b|\bgetopts\b/ },
    { name: "functions", pattern: /\b\w+\(\)\s*\{/ },
  ],
  ps1: [
    { name: "function", pattern: /\bfunction\s+[A-Za-z]/ },
    { name: "pipeline", pattern: /\b(Get-ChildItem|Import-Csv|Measure-Object|ForEach-Object|Where-Object)\b/ },
    { name: "try-catch", pattern: /\btry\s*\{/ },
    { name: "cmdlet-binding", pattern: /\[CmdletBinding\(\)\]/ },
    { name: "variables", pattern: /\$\w+/ },
    { name: "admin-or-network", pattern: /\b(Invoke-RestMethod|Test-Path|Registry|Get-Process)\b/ },
  ],
  php: [
    { name: "php-tag", pattern: /<\?php/ },
    { name: "variables", pattern: /\$\w+/ },
    { name: "pdo", pattern: /\bPDO\b/ },
    { name: "array-functions", pattern: /\b(array_map|array_filter|array_reduce|usort)\b/ },
    { name: "json", pattern: /\bjson_encode|json_decode\b/ },
    { name: "functions", pattern: /\bfunction\s+\w+/ },
  ],
  sql: [
    { name: "select", pattern: /\bSELECT\b/i },
    { name: "join", pattern: /\bJOIN\b/i },
    { name: "cte-window", pattern: /\b(WITH|OVER|PARTITION BY)\b/i },
    { name: "aggregate", pattern: /\b(GROUP BY|HAVING|ORDER BY)\b/i },
    { name: "write", pattern: /\b(INSERT|UPDATE|DELETE|CREATE)\b/i },
    { name: "transaction", pattern: /\b(BEGIN|COMMIT|ROLLBACK)\b/i },
  ],
  "asm-x86_64": [
    { name: "directive", pattern: /\.(globl|global|text|data|section)/ },
    { name: "registers", pattern: /\b(rdi|rsi|rax|rcx|rdx|r8|r9)\b/ },
    { name: "instructions", pattern: /\b(mov|lea|add|sub|imul|cmp|xor)\b/ },
    { name: "return", pattern: /\bret\b/ },
    { name: "stack", pattern: /\b(push|pop|rbp|rsp)\b/ },
    { name: "syscall", pattern: /\bsyscall\b/ },
  ],
  "asm-arm64": [
    { name: "directive", pattern: /\.(global|globl|text|data|section)/ },
    { name: "registers", pattern: /\b(x0|x1|x2|w0|w1|x29|x30)\b/ },
    { name: "instructions", pattern: /\b(ldr|str|add|sub|mul|cmp)\b/ },
    { name: "return", pattern: /\bret\b/ },
    { name: "stack", pattern: /\b(stp|ldp|sp)\b/ },
    { name: "branch", pattern: /\b(b|bl|b\.eq|cbz)\b/ },
  ],
  java: [
    { name: "class", pattern: /\b(public\s+)?(final\s+)?class\s+\w+/ },
    { name: "record-or-enum", pattern: /\b(record|enum|interface)\s+\w+/ },
    { name: "imports", pattern: /import\s+java\./ },
    { name: "streams", pattern: /\b(Stream|Collectors|CompletableFuture|ExecutorService)\b/ },
    { name: "generic-method", pattern: /<\w+(?:\s+extends\s+\w+)?>/ },
    { name: "exception", pattern: /\b(throw|catch|IllegalArgumentException)\b/ },
  ],
  cs: [
    { name: "using", pattern: /using\s+System/ },
    { name: "record-or-class", pattern: /\b(record|class|namespace)\b/ },
    { name: "linq", pattern: /\b(LINQ|Enumerable|\.Where\(|\.Select\()/ },
    { name: "async", pattern: /\b(async|await|Task)\b/ },
    { name: "var", pattern: /\bvar\s+\w+/ },
    { name: "concurrency", pattern: /\b(ConcurrentDictionary|Task\.WhenAll|lock\s*\()/ },
  ],
  rust: [
    { name: "fn", pattern: /\bfn\s+\w+/ },
    { name: "mutability", pattern: /\blet\s+mut\b/ },
    { name: "result-option", pattern: /\b(Result|Option)\b/ },
    { name: "collections", pattern: /\b(Vec|HashMap|BTreeMap)\b/ },
    { name: "trait-impl", pattern: /\b(impl|trait)\b/ },
    { name: "question-mark", pattern: /\?;/ },
    { name: "tests", pattern: /#\[test\]/ },
  ],
  go: [
    { name: "package", pattern: /package\s+\w+/ },
    { name: "functions", pattern: /\bfunc\s+\w+/ },
    { name: "concurrency", pattern: /\b(go\s+\w+|chan|WaitGroup|Mutex)\b/ },
    { name: "errors", pattern: /\berror\b/ },
    { name: "collections", pattern: /\b(map\[|\[\]\w+)/ },
    { name: "defer", pattern: /\bdefer\b/ },
  ],
};

function countConstructs(
  samples: readonly CodeSample[],
  language: string,
): ConstructStat[] {
  const specs = CONSTRUCTS[language] ?? [];
  return specs.map((spec) => ({
    name: spec.name,
    hits: samples.filter((sample) => spec.pattern.test(sample.code)).length,
    required: spec.required ?? INTERMEDIATE,
  }));
}

/** Hash estável do código usado para detectar duplicatas exatas. */
export function codeHash(code: string): string {
  return crypto.createHash("sha1").update(code).digest("hex");
}

/**
 * Pares de delimitadores por linguagem. No shell, padrões de `case` usam
 * `)` sem `(` correspondente e aspas aninhadas confundem a limpeza, então
 * apenas chaves são checadas.
 */
const BALANCE_PAIRS: Record<string, ReadonlyArray<readonly [string, string]>> = {
  sh: [["{", "}"]],
};

/** Validação completa: unicidade, tamanho, placeholders, sintaxe e constructos. */
export function validateSamples(samples: readonly CodeSample[]): QualityResult {
  const errors: QualityIssue[] = [];
  const byLanguage: Record<string, number> = {};
  const seenIds = new Set<string>();
  const seenCode = new Map<string, string>();
  let duplicateCodeHashes = 0;
  let minCodeLength = Number.POSITIVE_INFINITY;
  let maxCodeLength = 0;
  let totalCodeLength = 0;

  const add = (
    sample: CodeSample,
    kind: QualityIssue["kind"],
    message: string,
  ): void => {
    errors.push({ id: sample.id, language: sample.language, kind, message });
  };

  for (const sample of samples) {
    byLanguage[sample.language] = (byLanguage[sample.language] ?? 0) + 1;

    if (seenIds.has(sample.id)) add(sample, "duplicate-id", `duplicate id ${sample.id}`);
    seenIds.add(sample.id);

    if (!sample.instruction.trim() || !sample.task.trim() || !sample.explanation.trim()) {
      add(sample, "invalid-field", "instruction, task and explanation must be non-empty");
    }
    if (sample.tags.length === 0 || sample.tags.some((tag) => tag.trim().length === 0)) {
      add(sample, "invalid-field", "tags must be non-empty strings");
    }
    if (!["basic", "intermediate", "advanced"].includes(sample.difficulty)) {
      add(sample, "invalid-field", `unknown difficulty ${sample.difficulty}`);
    }

    const code = sample.code.trim();
    minCodeLength = Math.min(minCodeLength, code.length);
    maxCodeLength = Math.max(maxCodeLength, code.length);
    totalCodeLength += code.length;

    if (code.length < MIN_CODE_LENGTH) {
      add(sample, "short-code", `code has ${code.length} chars, minimum is ${MIN_CODE_LENGTH}`);
    }

    for (const pattern of PLACEHOLDER_PATTERNS) {
      if (pattern.test(code)) {
        add(sample, "placeholder", `placeholder pattern ${pattern} found`);
        break;
      }
    }

    const hash = codeHash(code);
    const previous = seenCode.get(hash);
    if (previous !== undefined) {
      duplicateCodeHashes += 1;
      add(sample, "duplicate-code", `code duplicates sample ${previous}`);
    } else {
      seenCode.set(hash, sample.id);
    }

    const clean = stripNonCode(code, sample.language);
    const pairs: ReadonlyArray<readonly [string, string]> = BALANCE_PAIRS[sample.language] ?? [
      ["{", "}"],
      ["(", ")"],
      ["[", "]"],
    ];
    if (!balancedBraces(clean, pairs)) {
      add(sample, "unbalanced", "unbalanced delimiters");
    }
  }

  const constructs: Record<string, ConstructStat[]> = {};
  for (const language of Object.keys(byLanguage)) {
    const languageSamples = samples.filter((sample) => sample.language === language);
    const stats = countConstructs(languageSamples, language);
    constructs[language] = stats;
    for (const stat of stats) {
      if (stat.hits < stat.required) {
        const first = languageSamples[0] as CodeSample;
        errors.push({
          id: first.id,
          language,
          kind: "missing-construct",
          message: `expected construct ${stat.name} in at least ${stat.required} sample(s), found ${stat.hits}`,
        });
      }
    }
  }

  const stats: QualityStats = {
    total: samples.length,
    byLanguage,
    uniqueIds: seenIds.size,
    duplicateCodeHashes,
    minCodeLength: samples.length === 0 ? 0 : minCodeLength,
    maxCodeLength,
    averageCodeLength:
      samples.length === 0 ? 0 : Math.round((totalCodeLength / samples.length) * 100) / 100,
    constructs,
  };

  return { ok: errors.length === 0, errors, stats };
}
