import fs from "node:fs";
import path from "node:path";
import { toPosix } from "./util";
import { walkFiles } from "../tools/fs";

export interface RepoMapOptions {
  maxFiles?: number;
  maxChars?: number;
}

const IMPORTANT = [
  "package.json", "tsconfig.json", "README.md", "Cargo.toml", "go.mod", "pyproject.toml",
  "requirements.txt", "CMakeLists.txt", "Makefile", "docker-compose.yml", "Dockerfile",
  "m5.agent.json", ".m5/agent.json",
];

/** Mapa textual compacto: árvore + arquivos-chave + contagem por linguagem. */
export function buildRepoMap(root: string, options: RepoMapOptions = {}): string {
  const maxFiles = options.maxFiles ?? 400;
  const maxChars = options.maxChars ?? 6_000;
  const files = walkFiles(root, { maxFiles: maxFiles * 3, maxFileBytes: 2_000_000 })
    .map((f) => toPosix(path.relative(root, f)))
    .filter((f) => !f.startsWith(".m5/"))
    .slice(0, maxFiles);

  const byLang = new Map<string, number>();
  for (const file of files) {
    const ext = path.extname(file).slice(1) || "other";
    byLang.set(ext, (byLang.get(ext) ?? 0) + 1);
  }

  const tops = new Map<string, string[]>();
  for (const file of files) {
    const parts = file.split("/");
    const key = parts.length > 1 ? `${parts[0]}/` : ".";
    const list = tops.get(key) ?? [];
    if (list.length < 25) list.push(parts.length > 1 ? parts.slice(1).join("/") : file);
    tops.set(key, list);
  }

  const keyFiles = IMPORTANT.filter((name) => fs.existsSync(path.join(root, name)));
  let pkgInfo = "";
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
      name?: string;
      scripts?: Record<string, string>;
    };
    pkgInfo = `pacote=${pkg.name ?? "?"} scripts=${Object.keys(pkg.scripts ?? {}).join(",")}`;
  } catch {
    /* projeto sem package.json */
  }

  const lines: string[] = [
    `raiz: ${toPosix(root)}`,
    pkgInfo,
    `arquivos indexáveis: ${files.length}`,
    `linguagens: ${[...byLang.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(" ")}`,
    keyFiles.length ? `arquivos-chave: ${keyFiles.join(", ")}` : "",
  ].filter(Boolean);

  for (const [dir, list] of [...tops.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`${dir} ${list.join(" ")}`);
  }

  const text = lines.join("\n");
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n[... mapa truncado]` : text;
}

export interface ContextChunk {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  text: string;
}

function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length > 2);
}

/** Recuperação lexical barata (sem embeddings) para dar contexto inicial ao modelo. */
export function retrieveContext(
  root: string,
  query: string,
  options: { limit?: number; maxChars?: number; maxFiles?: number } = {},
): ContextChunk[] {
  const limit = options.limit ?? 6;
  const maxChars = options.maxChars ?? 3_000;
  const queryTokens = [...new Set(tokenize(query))];
  if (queryTokens.length === 0) return [];

  const files = walkFiles(root, { maxFiles: options.maxFiles ?? 3_000, maxFileBytes: 300_000 })
    .map((f) => toPosix(path.relative(root, f)))
    .filter((f) => /\.(ts|tsx|js|jsx|py|c|h|cpp|hpp|rs|go|java|cs|php|sh|ps1|sql|md|json|ya?ml|toml)$/i.test(f))
    .slice(0, options.maxFiles ?? 3_000);

  const chunks: ContextChunk[] = [];
  for (const rel of files) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(root, rel), "utf8");
    } catch {
      continue;
    }
    if (text.includes("\u0000")) continue;
    const lines = text.split(/\r?\n/);
    const size = 50;
    const overlap = 10;
    for (let start = 0; start < lines.length; start += size - overlap) {
      const end = Math.min(lines.length, start + size);
      const body = lines.slice(start, end).join("\n");
      const lower = body.toLowerCase();
      let score = 0;
      for (const token of queryTokens) {
        if (lower.includes(token)) score += 1 + Math.min(3, body.split(token).length - 2) * 0.2;
      }
      if (score > 0) {
        chunks.push({ path: rel, startLine: start + 1, endLine: end, score, text: body });
      }
      if (end >= lines.length) break;
    }
  }

  chunks.sort((a, b) => b.score - a.score);
  const selected: ContextChunk[] = [];
  let chars = 0;
  for (const chunk of chunks) {
    if (selected.length >= limit || chars + chunk.text.length > maxChars) break;
    selected.push(chunk);
    chars += chunk.text.length;
  }
  return selected;
}

export function renderContextChunks(chunks: ContextChunk[]): string {
  if (chunks.length === 0) return "";
  return chunks
    .map((c) => `--- ${c.path}:${c.startLine}-${c.endLine} ---\n${c.text}`)
    .join("\n\n");
}
