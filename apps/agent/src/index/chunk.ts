/**
 * Chunking por linhas com overlap.
 *
 * Regras:
 * - janelas de ~40 linhas com 10 de overlap;
 * - quando possível, o início/fim da janela "gruda" em um símbolo, para não
 *   cortar uma função no meio;
 * - whitespace excessivo é normalizado (linhas em branco consecutivas viram
 *   uma só, espaços à direita somem);
 * - chunks têm limite de caracteres e são divididos por linha se necessário.
 */

import { hashString } from "../core/util";
import type { ChunkInfo, SymbolInfo } from "./types";

export interface ChunkOptions {
  /** Linhas alvo por chunk (padrão 40). */
  targetLines?: number;
  /** Linhas de overlap entre chunks vizinhos (padrão 10). */
  overlapLines?: number;
  /** Limite de caracteres por chunk (padrão 4000). */
  maxChars?: number;
  /** Mínimo de linhas para aceitar um corte alinhado a símbolo (padrão 5). */
  minLines?: number;
}

export const DEFAULT_TARGET_LINES = 40;
export const DEFAULT_OVERLAP_LINES = 10;
export const DEFAULT_MAX_CHARS = 4000;

/** Junta linhas removendo espaços à direita e colapsando linhas em branco. */
function normalizeRange(lines: string[], start: number, end: number): string {
  const out: string[] = [];
  let lastBlank = false;
  for (let i = start; i < end; i++) {
    const text = (lines[i] ?? "").replace(/[ \t]+$/g, "");
    if (text.trim() === "") {
      if (out.length > 0 && !lastBlank) {
        out.push("");
        lastBlank = true;
      }
      continue;
    }
    out.push(text);
    lastBlank = false;
  }
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out.join("\n");
}

/**
 * Divide um arquivo em chunks. `symbols` é opcional; quando presente, os
 * cortes são alinhados às linhas dos símbolos.
 */
export function chunkFile(
  file: string,
  content: string,
  symbols: SymbolInfo[] = [],
  options: ChunkOptions = {},
): ChunkInfo[] {
  if (!content.trim()) return [];

  const lines = content.split(/\r?\n/);
  const total = lines.length;
  const target = Math.max(4, options.targetLines ?? DEFAULT_TARGET_LINES);
  const overlap = Math.max(
    0,
    Math.min(options.overlapLines ?? DEFAULT_OVERLAP_LINES, target - 1),
  );
  const maxChars = Math.max(200, options.maxChars ?? DEFAULT_MAX_CHARS);
  const minLines = Math.max(1, Math.min(options.minLines ?? 5, target));

  const symbolLines = new Set(symbols.map((s) => s.line));
  const out: ChunkInfo[] = [];
  const seen = new Set<string>();

  const add = (startLine: number, endLine: number, text: string): void => {
    if (!text.trim()) return;
    const key = `${startLine}:${endLine}:${hashString(text)}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ id: `${file}:${startLine}-${endLine}`, file, startLine, endLine, text });
  };

  /** Emite um range respeitando o limite de caracteres. */
  const emit = (start: number, end: number): void => {
    const text = normalizeRange(lines, start, end);
    if (!text.trim()) return;
    if (text.length <= maxChars) {
      add(start + 1, end, text);
      return;
    }

    // Divide por linhas; linhas gigantes são cortadas na força.
    let pieceStart = start;
    let pieceEnd = start;
    let pieceLen = 0;

    const flush = (): void => {
      if (pieceEnd > pieceStart) {
        const piece = normalizeRange(lines, pieceStart, pieceEnd);
        if (piece.trim()) add(pieceStart + 1, pieceEnd, piece);
      }
    };

    for (let i = start; i < end; i++) {
      const len = (lines[i] ?? "").length + 1;
      if (len > maxChars) {
        flush();
        pieceStart = i + 1;
        pieceEnd = i + 1;
        pieceLen = 0;
        add(i + 1, i + 1, (lines[i] ?? "").slice(0, maxChars));
        continue;
      }
      if (pieceEnd > pieceStart && pieceLen + len > maxChars) {
        flush();
        pieceStart = i;
        pieceEnd = i;
        pieceLen = 0;
      }
      pieceEnd = i + 1;
      pieceLen += len;
    }
    flush();
  };

  let cursor = 0;
  while (cursor < total) {
    let start = cursor;

    // Puxa o início para um símbolo que comece logo após o cursor. Isso evita
    // que a sobreposição comece no meio de uma assinatura.
    const snapLimit = Math.min(start + Math.max(1, Math.floor(overlap / 2)), total - 1);
    for (let i = start; i <= snapLimit; i++) {
      if (symbolLines.has(i + 1)) {
        start = i;
        break;
      }
    }

    let end = Math.min(total, start + target);

    // Se um símbolo começa na cauda, termina o chunk antes dele.
    let snappedEnd = false;
    const tailFloor = Math.max(start + minLines, end - overlap);
    for (let i = end - 1; i >= tailFloor; i--) {
      if (symbolLines.has(i + 1)) {
        end = i;
        snappedEnd = true;
        break;
      }
    }

    while (start < end && (lines[start] ?? "").trim() === "") start++;
    while (end > start && (lines[end - 1] ?? "").trim() === "") end--;

    if (end > start) emit(start, end);
    if (end >= total) break;

    // Próximo cursor mantém o overlap, mas sempre avança. Quando o fim foi
    // alinhado a um símbolo, o próximo chunk começa exatamente nele para não
    // cortar a declaração.
    const next = snappedEnd
      ? Math.max(start + 1, end)
      : Math.max(start + 1, end - overlap);
    cursor = Math.max(cursor + 1, next);
  }

  return out;
}
