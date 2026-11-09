/**
 * Contratos do indexador de código do M5 Agent.
 *
 * O índice é intencionalmente "burro e portátil": um JSON com metadados dos
 * arquivos, símbolos extraídos, chunks e vetores determinísticos. Nada aqui
 * depende de rede ou de um modelo externo — o agente consegue reconstruir o
 * índice do zero a qualquer momento.
 */

/** Tipos de símbolo que o extrator reconhece. */
export type SymbolKind =
  | "function"
  | "class"
  | "method"
  | "interface"
  | "type"
  | "const"
  | "variable"
  | "struct"
  | "enum"
  | "trait"
  | "impl"
  | "module";

/** Um símbolo de código (função, classe, método, etc.). */
export interface SymbolInfo {
  name: string;
  kind: SymbolKind;
  /** Caminho relativo ao root do índice (sempre com "/"). */
  file: string;
  /** Linha 1-based onde o símbolo começa. */
  line: number;
  /** Primeira linha do símbolo, já normalizada/truncada. */
  signature: string;
}

/** Pedaço de arquivo indexado, com overlap em relação aos vizinhos. */
export interface ChunkInfo {
  /** Identificador estável: `<arquivo>:<startLine>-<endLine>`. */
  id: string;
  file: string;
  /** Linha inicial (1-based, inclusiva). */
  startLine: number;
  /** Linha final (1-based, inclusiva). */
  endLine: number;
  text: string;
}

/** Metadados de build (não fazem parte do contrato mínimo, mas ajudam o CLI). */
export interface IndexMeta {
  /** Arquivos visitados pelo walker (antes de descartar binários/ignorados). */
  scanned: number;
  /** Arquivos efetivamente no índice. */
  indexed: number;
  /** Arquivos reaproveitados do índice anterior (hash sha1 igual). */
  reused: number;
  /** Arquivos novos ou alterados. */
  changed: number;
  /** Arquivos que existiam no índice anterior e sumiram. */
  removed: number;
  /** Duração do build em milissegundos. */
  durationMs: number;
  /** Assinatura da configuração de chunking usada (para invalidar cache). */
  chunkSignature: string;
}

/** Um arquivo indexado. */
export interface IndexedFile {
  /** Caminho relativo ao root, com "/". */
  path: string;
  /** sha1 do conteúdo — base do build incremental. */
  hash: string;
  /** Linguagem detectada (extensão canônica: ts, py, c, ...). */
  lang: string;
  bytes: number;
  lines: number;
  symbols: SymbolInfo[];
  chunks: ChunkInfo[];
}

/** Índice completo, serializável em JSON. */
export interface CodeIndex {
  /** Versão do formato/algoritmo; invalida caches antigos. */
  version: number;
  /** Root absoluto (com "/"). */
  root: string;
  /** ISO timestamp do build. */
  createdAt: string;
  files: IndexedFile[];
  /** Dimensão dos vetores (embed.ts). */
  vectorDim: number;
  /** Vetores por id de chunk. */
  vectors: Record<string, number[]>;
  /** Estatísticas do último build (opcional em índices antigos). */
  meta?: IndexMeta;
}

/** Resultado de uma busca híbrida. */
export interface SearchHit {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  /** Nomes de símbolos que caem dentro do trecho. */
  symbols: string[];
}
