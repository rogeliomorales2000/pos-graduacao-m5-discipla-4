/**
 * Utilidades determinísticas usadas pelos geradores de dataset.
 *
 * Nada aqui depende de `Math.random`: a mesma seed produz exatamente a mesma
 * ordem de amostras, o que mantém o dataset reproduzível em CI.
 */
import type { Difficulty } from "./types.ts";

/** PRNG rápido e determinístico (mulberry32). */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return function next(): number {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Escolhe um elemento de uma lista não vazia de forma determinística. */
export function pick<T>(rng: () => number, items: readonly T[]): T {
  if (items.length === 0) throw new Error("pick: empty list");
  return items[Math.floor(rng() * items.length)] as T;
}

/**
 * Produto cartesiano tipado de dimensões nomeadas.
 *
 * `cartesian({ a: [1, 2], b: ["x", "y"] })` devolve quatro combinações.
 */
export function cartesian<D extends Record<string, readonly unknown[]>>(
  dimensions: D,
): Array<{ [K in keyof D]: D[K][number] }> {
  const keys = Object.keys(dimensions) as Array<keyof D>;
  let rows: Array<Record<string, unknown>> = [{}];
  for (const key of keys) {
    const values = dimensions[key];
    if (values.length === 0) return [];
    const next: Array<Record<string, unknown>> = [];
    for (const row of rows) {
      for (const value of values) next.push({ ...row, [key]: value });
    }
    rows = next;
  }
  return rows as Array<{ [K in keyof D]: D[K][number] }>;
}

/** Fisher-Yates determinístico: não modifica a lista recebida. */
export function shuffle<T>(rng: () => number, items: readonly T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = copy[i] as T;
    copy[i] = copy[j] as T;
    copy[j] = tmp;
  }
  return copy;
}

/** Remove amostras repetidas pelo id, preservando a primeira ocorrência. */
export function dedupeById<T extends { id: string }>(samples: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const sample of samples) {
    if (seen.has(sample.id)) continue;
    seen.add(sample.id);
    out.push(sample);
  }
  return out;
}

/** Falha cedo quando um gerador não atingiu o volume combinado. */
export function assertMinSamples<T>(samples: readonly T[], min: number, label = "dataset"): T[] {
  if (!Number.isInteger(min) || min <= 0) throw new Error(`assertMinSamples: invalid min ${min}`);
  if (samples.length < min) {
    throw new Error(`${label}: expected at least ${min} samples, got ${samples.length}`);
  }
  return [...samples];
}

const PAIR_OPEN = new Set(["{", "(", "["]);
const PAIR_CLOSE: Record<string, string> = { "}": "{", ")": "(", "]": "[" };

/**
 * Verifica aninhamento de delimitadores.
 *
 * Passe o código já limpo de strings/comentários quando eles puderem conter
 * chaves (por exemplo, HTML, JSON ou templates). A função rejeita tanto
 * fechamento sem abertura quanto abertura pendente.
 */
export function balancedBraces(
  code: string,
  pairs: ReadonlyArray<readonly [string, string]> = [
    ["{", "}"],
    ["(", ")"],
    ["[", "]"],
  ],
): boolean {
  const openers = new Set<string>();
  const closers = new Map<string, string>();
  for (const [open, close] of pairs) {
    openers.add(open);
    closers.set(close, open);
  }
  const stack: string[] = [];
  for (const ch of code) {
    if (openers.has(ch)) {
      stack.push(ch);
    } else if (closers.has(ch)) {
      if (stack.pop() !== closers.get(ch)) return false;
    }
  }
  return stack.length === 0;
}

export interface DifficultyInput {
  base?: Difficulty;
  algorithm?: string;
  style?: string;
  edge?: string;
  features?: number;
}

/**
 * Heurística transparente: a dificuldade declarada pelo cenário é elevada
 * quando entram em jogo recursão, concorrência, genéricos, ownership, etc.
 */
export function estimateDifficulty(input: DifficultyInput = {}): Difficulty {
  let score = input.base === "advanced" ? 2 : input.base === "intermediate" ? 1 : 0;
  const algorithm = (input.algorithm ?? "").toLowerCase();
  const advanced = [
    "recursion",
    "generic",
    "trait",
    "ownership",
    "concurrency",
    "goroutine",
    "async",
    "stream",
    "window",
    "recursive",
    "template",
    "move",
    "iterator",
    "variant",
    "syscall",
  ];
  const intermediate = [
    "reduce",
    "map",
    "group",
    "binary",
    "sort",
    "pipeline",
    "regex",
    "parser",
    "memoize",
    "retry",
  ];
  if (advanced.some((word) => algorithm.includes(word))) score += 2;
  else if (intermediate.some((word) => algorithm.includes(word))) score += 1;
  if ((input.style ?? "") === "defensive") score += 1;
  if ((input.edge ?? "") === "negative" || (input.edge ?? "") === "large") score += 1;
  score += Math.max(0, Math.trunc(input.features ?? 0));
  if (score >= 4) return "advanced";
  if (score >= 2) return "intermediate";
  return "basic";
}

/** Hash FNV-1a estável para chaves curtas (não é criptográfico). */
export function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
