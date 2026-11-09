/**
 * Busca híbrida sobre o índice.
 *
 * Combina três sinais:
 * - lexical (BM25-lite) sobre o texto do chunk;
 * - cosseno entre o embedding da consulta e o vetor do chunk;
 * - bônus estrutural (símbolo no trecho / termo no caminho).
 *
 * Resultados são agrupados por arquivo e trechos sobrepostos são deduplicados,
 * para o agente não receber cinco cópias da mesma função.
 */

import { cosine, embed, EMBED_DIM, hybridScore, lexicalScore, tokenize } from "./embed";
import type { CodeIndex, SearchHit, SymbolInfo } from "./types";

export interface SearchOptions {
  /** Número máximo de resultados (padrão 10). */
  limit?: number;
  /** Filtra por linguagem (ex.: "ts", "py"). */
  lang?: string;
  /** Filtra por prefixo de caminho relativo (ex.: "src/"). */
  pathPrefix?: string;
  /** Máximo de trechos por arquivo (padrão 2). */
  perFile?: number;
  /** Pontuação mínima para considerar um trecho (padrão 0.01). */
  minScore?: number;
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function normalizePrefix(prefix: string): string {
  return prefix.replace(/\\/g, "/").replace(/^\.\//, "");
}

function makeSnippet(text: string, max = 700): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, max).replace(/\s+\S*$/, "") + "\n…";
}

/** Bônus para símbolos do trecho cujo nome casa com a consulta. */
function symbolBonus(
  symbols: SymbolInfo[],
  startLine: number,
  endLine: number,
  queryTokens: Set<string>,
): number {
  let best = 0;
  for (const symbol of symbols) {
    if (symbol.line < startLine || symbol.line > endLine) continue;
    const nameTokens = tokenize(symbol.name);
    let overlap = 0;
    for (const token of nameTokens) {
      if (queryTokens.has(token)) overlap++;
    }
    if (overlap === 0) continue;
    const exact = queryTokens.has(symbol.name.toLowerCase()) ? 1 : 0;
    const bonus = Math.min(2.5, 0.8 + 0.6 * overlap + exact * 1.2);
    if (bonus > best) best = bonus;
  }
  return best;
}

function symbolsInRange(
  symbols: SymbolInfo[],
  startLine: number,
  endLine: number,
): string[] {
  const names: string[] = [];
  for (const symbol of symbols) {
    if (symbol.line < startLine || symbol.line > endLine) continue;
    if (!names.includes(symbol.name)) names.push(symbol.name);
    if (names.length >= 16) break;
  }
  return names;
}

/** Bônus pequeno quando o termo aparece no caminho do arquivo. */
function pathBonus(filePath: string, queryTokens: Set<string>): number {
  const lower = filePath.toLowerCase();
  let bonus = 0;
  for (const token of queryTokens) {
    if (token.length < 3) continue;
    if (lower.includes(token)) bonus += 0.5;
    if (bonus >= 1.5) return 1.5;
  }
  return bonus;
}

/** Dois trechos colidem se compartilham a maior parte das linhas. */
function overlaps(a: SearchHit, b: SearchHit): boolean {
  const inter =
    Math.min(a.endLine, b.endLine) - Math.max(a.startLine, b.startLine) + 1;
  if (inter <= 0) return false;
  const minLen = Math.min(
    a.endLine - a.startLine + 1,
    b.endLine - b.startLine + 1,
  );
  return minLen > 0 && inter / minLen >= 0.6;
}

/**
 * Busca híbrida no índice. Devolve os melhores trechos, agrupados por arquivo
 * e com overlap deduplicado.
 */
export function search(
  index: CodeIndex,
  query: string,
  options: SearchOptions = {},
): SearchHit[] {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) return [];

  const limit = Math.max(1, options.limit ?? 10);
  const perFile = Math.max(1, options.perFile ?? 2);
  const minScore = options.minScore ?? 0.01;
  const prefix = options.pathPrefix ? normalizePrefix(options.pathPrefix) : "";

  const queryVector = embed(trimmedQuery);
  const queryTokens = new Set(tokenize(trimmedQuery));

  const groups = new Map<string, SearchHit[]>();

  for (const file of index.files) {
    if (options.lang && file.lang !== options.lang) continue;
    if (prefix && !file.path.startsWith(prefix)) continue;

    const filePathBonus = pathBonus(file.path, queryTokens);

    for (const chunk of file.chunks) {
      const lexical = lexicalScore(trimmedQuery, chunk.text);
      const stored = index.vectors[chunk.id];
      const vector =
        stored && stored.length === EMBED_DIM
          ? cosine(queryVector, stored)
          : cosine(queryVector, embed(chunk.text));
      const symbol = symbolBonus(
        file.symbols,
        chunk.startLine,
        chunk.endLine,
        queryTokens,
      );

      const score = hybridScore({
        lexical,
        vector,
        symbol,
        path: filePathBonus,
      });
      if (score <= minScore) continue;

      const hit: SearchHit = {
        path: file.path,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        score: round(score),
        snippet: makeSnippet(chunk.text),
        symbols: symbolsInRange(file.symbols, chunk.startLine, chunk.endLine),
      };

      const bucket = groups.get(file.path);
      if (bucket) bucket.push(hit);
      else groups.set(file.path, [hit]);
    }
  }

  const merged: SearchHit[] = [];
  for (const bucket of groups.values()) {
    bucket.sort((a, b) => b.score - a.score);
    const kept: SearchHit[] = [];
    for (const hit of bucket) {
      if (kept.some((existing) => overlaps(existing, hit))) continue;
      kept.push(hit);
      if (kept.length >= perFile) break;
    }
    merged.push(...kept);
  }

  merged.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return merged.slice(0, limit);
}

/**
 * Procura símbolos por nome (exato primeiro, depois substring, case-insensitive).
 */
export function findSymbols(
  index: CodeIndex,
  name: string,
  limit = 50,
): SymbolInfo[] {
  const needle = name.trim().toLowerCase();
  if (!needle) return [];

  const exact: SymbolInfo[] = [];
  const partial: SymbolInfo[] = [];

  for (const file of index.files) {
    for (const symbol of file.symbols) {
      const lower = symbol.name.toLowerCase();
      if (lower === needle) exact.push(symbol);
      else if (lower.includes(needle)) partial.push(symbol);
    }
  }

  return [...exact, ...partial].slice(0, Math.max(1, limit));
}
