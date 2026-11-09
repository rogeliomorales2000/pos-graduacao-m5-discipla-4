/**
 * Renderiza um "mapa do repositório" compacto para o prompt de sistema.
 *
 * Formato: árvore de diretórios + arquivos com linguagem/linhas e os principais
 * símbolos de cada um. O orçamento de caracteres evita estourar o contexto.
 */

import type { CodeIndex, IndexedFile, SymbolKind } from "./types";

/** Prioridade para o mapa: o que "define" o arquivo aparece primeiro. */
const KIND_ORDER: Record<SymbolKind, number> = {
  class: 0,
  function: 1,
  interface: 2,
  type: 3,
  struct: 4,
  trait: 5,
  enum: 6,
  impl: 7,
  module: 8,
  method: 9,
  const: 10,
  variable: 11,
};

export interface RepoMapOptions {
  /** Máximo de arquivos listados (padrão 200). */
  maxFiles?: number;
  /** Orçamento total de caracteres (padrão 12000). */
  maxChars?: number;
  /** Símbolos por arquivo (padrão 8). */
  symbolsPerFile?: number;
}

interface DirNode {
  name: string;
  dirs: Map<string, DirNode>;
  files: IndexedFile[];
}

function emptyNode(name: string): DirNode {
  return { name, dirs: new Map(), files: [] };
}

function insert(root: DirNode, file: IndexedFile): void {
  const parts = file.path.split("/");
  const fileName = parts.pop() ?? file.path;
  let node = root;
  for (const part of parts) {
    let child = node.dirs.get(part);
    if (!child) {
      child = emptyNode(part);
      node.dirs.set(part, child);
    }
    node = child;
  }
  // Guarda o nome base para renderizar sem o caminho inteiro.
  node.files.push({ ...file, path: fileName });
}

interface Budget {
  files: number;
  chars: number;
  maxFiles: number;
  maxChars: number;
  truncated: boolean;
}

/**
 * Gera o mapa em texto. Sempre inclui o cabeçalho; corta a listagem quando o
 * orçamento de arquivos ou caracteres acaba.
 */
export function renderRepoMap(
  index: CodeIndex,
  options: RepoMapOptions = {},
): string {
  const maxFiles = Math.max(1, options.maxFiles ?? 200);
  const maxChars = Math.max(200, options.maxChars ?? 12000);
  const symbolsPerFile = Math.max(0, options.symbolsPerFile ?? 8);

  const totalSymbols = index.files.reduce((n, f) => n + f.symbols.length, 0);
  const totalChunks = index.files.reduce((n, f) => n + f.chunks.length, 0);

  const tree = emptyNode("");
  for (const file of [...index.files].sort((a, b) => a.path.localeCompare(b.path))) {
    insert(tree, file);
  }

  const lines: string[] = [
    `# Repo map — ${index.root}`,
    `# ${index.files.length} arquivos · ${totalSymbols} símbolos · ${totalChunks} chunks · dim ${index.vectorDim}`,
    "",
  ];

  const budget: Budget = {
    files: 0,
    chars: lines.join("\n").length,
    maxFiles,
    maxChars: maxChars - 80,
    truncated: false,
  };

  const render = (node: DirNode, depth: number): void => {
    if (budget.truncated) return;
    const indent = "  ".repeat(depth);

    for (const dirName of [...node.dirs.keys()].sort()) {
      if (budget.truncated) return;
      const child = node.dirs.get(dirName);
      if (!child) continue;
      const line = `${indent}${dirName}/`;
      if (budget.chars + line.length + 1 > budget.maxChars) {
        budget.truncated = true;
        return;
      }
      lines.push(line);
      budget.chars += line.length + 1;
      render(child, depth + 1);
    }

    for (const file of node.files.sort((a, b) => a.path.localeCompare(b.path))) {
      if (budget.truncated) return;
      if (budget.files >= budget.maxFiles) {
        budget.truncated = true;
        return;
      }
      const ordered = [...file.symbols].sort(
        (a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.line - b.line,
      );
      const names = ordered
        .slice(0, symbolsPerFile)
        .map((symbol) => symbol.name)
        .join(", ");
      const more = ordered.length > symbolsPerFile ? ", …" : "";
      const suffix = names ? `  ${names}${more}` : "";
      const line = `${indent}${file.path}  [${file.lang}, ${file.lines}L]${suffix}`;
      if (budget.chars + line.length + 1 > budget.maxChars) {
        budget.truncated = true;
        return;
      }
      lines.push(line);
      budget.chars += line.length + 1;
      budget.files++;
    }
  };

  render(tree, 0);

  if (budget.truncated) {
    const remaining = index.files.length - budget.files;
    if (remaining > 0) lines.push(`… +${remaining} arquivos (mapa truncado)`);
  }

  let text = lines.join("\n");
  if (text.length > maxChars) {
    text = text.slice(0, Math.max(0, maxChars - 30)).replace(/\s+\S*$/, "");
    text += "\n… (mapa truncado)";
  }
  return text;
}
