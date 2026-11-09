/**
 * Construção/persistência do índice.
 *
 * O build é incremental por sha1: arquivos com o mesmo hash de um índice
 * anterior reaproveitam símbolos, chunks e vetores. O restante é reindexado.
 * O JSON final é autocontido e pode ser salvo/carregado sem dependências.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ensureDir, toPosix } from "../core/util";
import { chunkFile, DEFAULT_MAX_CHARS, DEFAULT_OVERLAP_LINES, DEFAULT_TARGET_LINES, type ChunkOptions } from "./chunk";
import { EMBED_DIM, embed } from "./embed";
import { extractSymbols } from "./symbols";
import type { CodeIndex, IndexedFile, IndexMeta } from "./types";
import { walkRepo } from "./walk";

/** Versão do formato. Incremente ao mudar chunking/embedding de forma incompatível. */
export const INDEX_VERSION = 1;

export const DEFAULT_MAX_FILES = 4000;
export const DEFAULT_MAX_FILE_BYTES = 512 * 1024;

/** Caminho padrão do índice dentro do workspace. */
export function defaultStorePath(root: string): string {
  return path.join(path.resolve(root), ".m5", "code-index.json");
}

function sha1(buffer: Buffer): string {
  return crypto.createHash("sha1").update(buffer).digest("hex");
}

function countLines(content: string): number {
  if (content.length === 0) return 0;
  return content.split(/\r?\n/).length;
}

function chunkSignature(options: ChunkOptions | undefined): string {
  return [
    options?.targetLines ?? DEFAULT_TARGET_LINES,
    options?.overlapLines ?? DEFAULT_OVERLAP_LINES,
    options?.maxChars ?? DEFAULT_MAX_CHARS,
  ].join("/");
}

export interface BuildIndexOptions {
  root: string;
  /** Máximo de arquivos a indexar (padrão 4000). */
  maxFiles?: number;
  /** Tamanho máximo por arquivo em bytes (padrão 512 KiB). */
  maxFileBytes?: number;
  /** Índice anterior para reuso; se omitido, tenta carregar do store. */
  previous?: CodeIndex | null;
  /** Onde procurar/salvar o índice para reuso automático. */
  storePath?: string;
  /** `false` desliga o carregamento automático do índice anterior. */
  useCache?: boolean;
  /** Opções de chunking (fazem parte da assinatura de cache). */
  chunk?: ChunkOptions;
}

/**
 * Constrói o índice de `root`. Síncrono e determinístico; reusa arquivos
 * inalterados quando `previous` (ou o store padrão) está disponível.
 */
export function buildIndex(options: BuildIndexOptions): CodeIndex {
  const started = Date.now();
  const root = path.resolve(options.root);
  const maxFiles = Math.max(1, options.maxFiles ?? DEFAULT_MAX_FILES);
  const maxFileBytes = Math.max(1, options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES);
  const signature = chunkSignature(options.chunk);

  let previous = options.previous ?? null;
  if (!previous && options.useCache !== false) {
    const store = options.storePath ?? defaultStorePath(root);
    const loaded = loadIndex(store);
    if (loaded && loaded.version === INDEX_VERSION) previous = loaded;
  }
  const canReuse =
    !previous ||
    !previous.meta ||
    previous.meta.chunkSignature === signature;

  const prevByPath = new Map<string, IndexedFile>();
  if (previous) {
    for (const file of previous.files) prevByPath.set(file.path, file);
  }

  const walked = walkRepo({ root, maxFiles, maxFileBytes });
  const files: IndexedFile[] = [];
  const vectors: Record<string, number[]> = {};
  let reused = 0;
  let changed = 0;

  for (const entry of walked) {
    let buffer: Buffer;
    try {
      buffer = fs.readFileSync(entry.abs);
    } catch {
      continue;
    }

    const hash = sha1(buffer);
    const prev = prevByPath.get(entry.path);
    const sameContent =
      canReuse && prev !== undefined && prev.hash === hash && prev.lang === entry.lang;

    if (sameContent && prev) {
      // Reusa metadados pesados; só atualiza o que é barato.
      const content = buffer.toString("utf8");
      const file: IndexedFile = {
        ...prev,
        bytes: entry.bytes,
        lines: countLines(content),
      };
      files.push(file);
      for (const chunk of file.chunks) {
        const cached = previous?.vectors[chunk.id];
        vectors[chunk.id] =
          cached && cached.length === EMBED_DIM ? cached : embed(chunk.text);
      }
      reused++;
      continue;
    }

    const content = buffer.toString("utf8");
    const symbols = extractSymbols(entry.path, entry.lang, content);
    const chunks = chunkFile(entry.path, content, symbols, options.chunk);
    const file: IndexedFile = {
      path: entry.path,
      hash,
      lang: entry.lang,
      bytes: entry.bytes,
      lines: countLines(content),
      symbols,
      chunks,
    };
    files.push(file);
    for (const chunk of chunks) vectors[chunk.id] = embed(chunk.text);
    changed++;
  }

  const currentPaths = new Set(files.map((f) => f.path));
  let removed = 0;
  for (const oldPath of prevByPath.keys()) {
    if (!currentPaths.has(oldPath)) removed++;
  }

  const meta: IndexMeta = {
    scanned: walked.length,
    indexed: files.length,
    reused,
    changed,
    removed,
    durationMs: Date.now() - started,
    chunkSignature: signature,
  };

  return {
    version: INDEX_VERSION,
    root: toPosix(root),
    createdAt: new Date().toISOString(),
    files,
    vectorDim: EMBED_DIM,
    vectors,
    meta,
  };
}

/** Salva o índice em JSON compacto. Devolve o caminho final. */
export function saveIndex(
  index: CodeIndex,
  file: string = defaultStorePath(index.root),
): string {
  const target = path.resolve(file);
  ensureDir(path.dirname(target));
  fs.writeFileSync(target, JSON.stringify(index));
  return target;
}

/** Carrega um índice; devolve `null` se o arquivo não existir ou for inválido. */
export function loadIndex(file: string): CodeIndex | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as CodeIndex;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !Array.isArray(parsed.files) ||
      typeof parsed.version !== "number" ||
      typeof parsed.vectors !== "object" ||
      parsed.vectors === null
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Estatísticas agregadas para CLI/prompt. */
export interface IndexStats {
  root: string;
  version: number;
  createdAt: string;
  files: number;
  bytes: number;
  lines: number;
  symbols: number;
  chunks: number;
  vectors: number;
  vectorDim: number;
  languages: Record<string, number>;
  meta?: IndexMeta;
}

export function indexStats(index: CodeIndex): IndexStats {
  let bytes = 0;
  let lines = 0;
  let symbols = 0;
  let chunks = 0;
  const languages: Record<string, number> = {};

  for (const file of index.files) {
    bytes += file.bytes;
    lines += file.lines;
    symbols += file.symbols.length;
    chunks += file.chunks.length;
    languages[file.lang] = (languages[file.lang] ?? 0) + 1;
  }

  return {
    root: index.root,
    version: index.version,
    createdAt: index.createdAt,
    files: index.files.length,
    bytes,
    lines,
    symbols,
    chunks,
    vectors: Object.keys(index.vectors).length,
    vectorDim: index.vectorDim,
    languages,
    meta: index.meta,
  };
}
