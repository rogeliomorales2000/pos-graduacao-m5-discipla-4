/**
 * Embedding determinístico por hashing de tokens (feature hashing).
 *
 * Por que não um modelo neural? Porque o agente precisa indexar rápido, offline
 * e de forma reprodutível. O vetor é apenas um "saco de tokens" assinado:
 * cada token vira uma posição em `[0, dim)` e um sinal (+1/-1). Isso reduz o
 * viés de colisão e dá similaridade de cosseno útil para ranquear trechos.
 *
 * A busca também usa uma pontuação lexical estilo BM25, então o vetor não
 * precisa ser perfeito — ele só precisa capturar vizinhança semântica grossa.
 */

import { hashString } from "../core/util";

/** Dimensão padrão dos vetores do índice. */
export const EMBED_DIM = 256;

/**
 * Palavras muito comuns em código/inglês/português. Removê-las evita que
 * `const`, `function`, `return` etc. dominem a similaridade.
 */
const STOPWORDS = new Set([
  // palavras-chave de código
  "const",
  "let",
  "var",
  "function",
  "func",
  "fn",
  "def",
  "return",
  "if",
  "else",
  "elif",
  "for",
  "while",
  "do",
  "switch",
  "case",
  "break",
  "continue",
  "class",
  "new",
  "this",
  "self",
  "super",
  "import",
  "from",
  "export",
  "default",
  "async",
  "await",
  "yield",
  "try",
  "catch",
  "finally",
  "throw",
  "throws",
  "true",
  "false",
  "null",
  "undefined",
  "void",
  "public",
  "private",
  "protected",
  "internal",
  "static",
  "final",
  "abstract",
  "override",
  "virtual",
  "readonly",
  "interface",
  "struct",
  "enum",
  "trait",
  "impl",
  "type",
  "typedef",
  "using",
  "namespace",
  "module",
  "package",
  "extends",
  "implements",
  "with",
  "as",
  "in",
  "of",
  "is",
  "not",
  "and",
  "or",
  "int",
  "char",
  "float",
  "double",
  "long",
  "short",
  "unsigned",
  "signed",
  "bool",
  "boolean",
  "string",
  "str",
  "number",
  "object",
  "any",
  "unknown",
  "never",
  // inglês/português genéricos
  "the",
  "a",
  "an",
  "to",
  "de",
  "do",
  "da",
  "dos",
  "das",
  "em",
  "no",
  "na",
  "um",
  "uma",
  "que",
  "com",
  "para",
  "por",
  "se",
  "os",
  "as",
  "e",
]);

/** Tokens comuns em código que merecem IDF menor. */
const COMMON_CODE_TOKENS = new Set([
  "data",
  "name",
  "value",
  "values",
  "text",
  "file",
  "files",
  "path",
  "paths",
  "index",
  "list",
  "array",
  "item",
  "items",
  "result",
  "results",
  "error",
  "errors",
  "options",
  "config",
  "context",
  "args",
  "params",
  "input",
  "output",
  "size",
  "length",
  "count",
  "key",
  "keys",
  "map",
  "set",
  "get",
  "add",
  "run",
  "main",
  "util",
  "utils",
  "helper",
]);

const IDENTIFIER_RE = /[A-Za-z_$][\w$]*|\d+(?:\.\d+)?/g;

/**
 * Remove comentários e normaliza literais de string/número antes de tokenizar.
 * A ideia é que `"foo"` e `"bar"` contribuam igualmente (como `$str$`), sem
 * apagar identificadores que aparecem fora de strings.
 */
export function normalizeCode(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n\r]*/g, " ")
    .replace(/(["'`])(?:\\.|(?!\1)[^\\\n\r])*\1/g, " $str$ ")
    .replace(/\b\d+(?:\.\d+)?\b/g, " $num$ ");
}

/** Divide `trainGpt`, `HTTPClient` ou `load_rows` em pedaços menores. */
export function splitIdentifier(raw: string): string[] {
  const parts: string[] = [];
  for (const chunk of raw.split(/[_\W]+/)) {
    if (!chunk) continue;
    const pieces = chunk
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .split(/\s+/);
    for (const piece of pieces) if (piece) parts.push(piece);
  }
  return parts;
}

/**
 * Tokeniza código: preserva o identificador completo E seus pedaços
 * (camelCase/snake_case), ignorando stopwords. Números e strings viram
 * placeholders e são descartados.
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const source = normalizeCode(text);
  const matches = source.match(IDENTIFIER_RE);
  if (!matches) return tokens;

  for (const raw of matches) {
    const lower = raw.toLowerCase();
    if (lower === "$str$" || lower === "$num$") continue;
    if (STOPWORDS.has(lower)) continue;
    tokens.push(lower);
    for (const part of splitIdentifier(raw)) {
      const piece = part.toLowerCase();
      if (piece.length < 2 || piece === lower) continue;
      if (STOPWORDS.has(piece)) continue;
      tokens.push(piece);
    }
  }
  return tokens;
}

function round(value: number, digits = 6): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * Gera um vetor L2-normalizado de dimensão `dim` (padrão 256).
 * Determinístico: o mesmo texto sempre produz o mesmo vetor.
 */
export function embed(text: string, dim: number = EMBED_DIM): number[] {
  const vec = new Array<number>(dim).fill(0);
  const tokens = tokenize(text);

  for (const token of tokens) {
    const idx = hashString(token) % dim;
    // Sinal derivado de um segundo hash: reduz cancelamento por colisão.
    const sign = (hashString(":" + token) & 1) === 0 ? 1 : -1;
    vec[idx] += sign;
  }

  // Compressão sublinear (estilo tf log) para tokens muito repetidos.
  for (let i = 0; i < dim; i++) {
    const v = vec[i];
    vec[i] = v === 0 ? 0 : Math.sign(v) * Math.log1p(Math.abs(v));
  }

  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < dim; i++) vec[i] = round(vec[i] / norm);
  }
  return vec;
}

/** Similaridade de cosseno entre dois vetores (0 quando algum é nulo). */
export function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  if (na === 0 || nb === 0) return 0;
  const sim = dot / Math.sqrt(na * nb);
  return Math.max(-1, Math.min(1, sim));
}

/** IDF aproximado, sem corpus: tokens longos/específicos pesam mais. */
function pseudoIdf(token: string): number {
  let idf = 0.6 + Math.min(2, token.length / 6);
  if (COMMON_CODE_TOKENS.has(token)) idf *= 0.5;
  if (token.length >= 8) idf *= 1.15;
  return idf;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * BM25-lite: saturação de frequência + normalização por tamanho do documento,
 * com IDF aproximado. Também dá bônus para identificador exato e para a
 * consulta inteira aparecendo como substring.
 */
export function lexicalScore(query: string, text: string): number {
  const queryTokens = Array.from(new Set(tokenize(query)));
  if (queryTokens.length === 0) return 0;

  const docTokens = tokenize(text);
  if (docTokens.length === 0) return 0;

  const tf = new Map<string, number>();
  for (const token of docTokens) tf.set(token, (tf.get(token) ?? 0) + 1);

  const dl = docTokens.length;
  const avgdl = 120;
  const k1 = 1.2;
  const b = 0.75;
  let score = 0;

  for (const token of queryTokens) {
    const freq = tf.get(token) ?? 0;
    if (freq === 0) continue;
    const idf = pseudoIdf(token);
    score += (idf * (freq * (k1 + 1))) / (freq + k1 * (1 - b + (b * dl) / avgdl));
  }

  const lowerText = text.toLowerCase();
  for (const token of queryTokens) {
    if (token.length < 3) continue;
    const re = new RegExp(`\\b${escapeRegExp(token)}\\b`, "i");
    if (re.test(lowerText)) score += 0.8;
  }

  const phrase = query.trim().toLowerCase();
  if (phrase.length >= 3 && lowerText.includes(phrase)) score += 2;

  return score;
}

/** Partes de uma pontuação híbrida. */
export interface HybridParts {
  lexical: number;
  vector: number;
  /** Bônus por símbolo do trecho casar com a consulta. */
  symbol?: number;
  /** Bônus por termo aparecer no caminho do arquivo. */
  path?: number;
}

export interface HybridWeights {
  lexical?: number;
  vector?: number;
  symbol?: number;
  path?: number;
}

export const HYBRID_WEIGHTS: Required<HybridWeights> = {
  lexical: 1,
  vector: 2.2,
  symbol: 1.4,
  path: 0.6,
};

/** Combina sinal lexical (BM25), semântico (cosseno) e bônus estruturais. */
export function hybridScore(
  parts: HybridParts,
  weights: HybridWeights = {},
): number {
  const w = { ...HYBRID_WEIGHTS, ...weights };
  return (
    parts.lexical * w.lexical +
    parts.vector * w.vector +
    (parts.symbol ?? 0) * w.symbol +
    (parts.path ?? 0) * w.path
  );
}
