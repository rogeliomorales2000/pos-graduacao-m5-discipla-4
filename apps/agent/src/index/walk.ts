/**
 * Varredura de repositório com ignores padrão + `.gitignore` simples.
 *
 * O walker é síncrono e determinístico (ordem alfabética) para que o índice
 * gerado seja reproduzível. Ele nunca segue symlinks e descarta binários por
 * extensão e por "sniff" de bytes nulos.
 */

import fs from "node:fs";
import path from "node:path";

/** Diretórios ignorados por padrão em qualquer profundidade. */
export const DEFAULT_IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "coverage",
  ".m5",
  "models",
  "dataset",
  ".turbo",
  ".cache",
  "__pycache__",
  ".venv",
  "venv",
  "target",
  "vendor",
]);

/** Extensões tratadas como binárias (nunca indexadas). */
const BINARY_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "ico",
  "pdf",
  "zip",
  "rar",
  "7z",
  "gz",
  "tgz",
  "tar",
  "bz2",
  "xz",
  "exe",
  "dll",
  "so",
  "dylib",
  "bin",
  "wasm",
  "woff",
  "woff2",
  "ttf",
  "otf",
  "eot",
  "mp3",
  "mp4",
  "wav",
  "ogg",
  "avi",
  "mov",
  "mkv",
  "flac",
  "sqlite",
  "sqlite3",
  "db",
  "class",
  "jar",
  "pyc",
  "o",
  "obj",
  "a",
  "lib",
  "pt",
  "pth",
  "onnx",
  "gguf",
  "safetensors",
]);

/** Extensão canônica -> linguagem usada pelo extrator de símbolos. */
const LANG_BY_EXT: Record<string, string> = {
  ts: "ts",
  tsx: "tsx",
  mts: "ts",
  cts: "ts",
  js: "js",
  jsx: "jsx",
  mjs: "js",
  cjs: "js",
  py: "py",
  pyw: "py",
  c: "c",
  h: "h",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hpp: "hpp",
  hh: "hpp",
  hxx: "hpp",
  rs: "rs",
  go: "go",
  java: "java",
  cs: "cs",
  php: "php",
  sh: "sh",
  bash: "sh",
  ps1: "ps1",
  psm1: "ps1",
  sql: "sql",
  md: "md",
  markdown: "md",
  json: "json",
  yml: "yml",
  yaml: "yaml",
  toml: "toml",
};

/** Detecta a linguagem pela extensão; `null` para arquivos não indexáveis. */
export function detectLang(filePath: string): string | null {
  const base = path.basename(filePath).toLowerCase();
  // Arquivos gerados/minificados não agregam ao mapa do repositório.
  if (
    base.endsWith(".min.js") ||
    base.endsWith(".min.css") ||
    base.endsWith(".map") ||
    base.endsWith(".d.ts")
  ) {
    return null;
  }
  const dot = base.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = base.slice(dot + 1);
  if (BINARY_EXTENSIONS.has(ext)) return null;
  return LANG_BY_EXT[ext] ?? null;
}

interface IgnoreRule {
  negate: boolean;
  regex: RegExp;
}

/** Converte um glob simples de `.gitignore` em regex. */
function globToRegex(glob: string): string {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i++;
        // `**/` também casa zero diretórios.
        if (glob[i + 1] === "/") i++;
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else if ("\\^$+.|()[]{}".includes(ch)) {
      out += "\\" + ch;
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * Carrega `<root>/.gitignore` e devolve um predicado `(relPath, isDir)`.
 * Suporta comentários, `!` (negação), `/` inicial (ancorado), `/` final
 * (diretório) e `*`/`**`/`?`. É um subconjunto — suficiente para uso real.
 */
export function loadGitignore(
  root: string,
): (relPath: string, isDir: boolean) => boolean {
  const rules: IgnoreRule[] = [];
  const file = path.join(root, ".gitignore");
  try {
    const raw = fs.readFileSync(file, "utf8");
    for (const rawLine of raw.split(/\r?\n/)) {
      let line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;

      let negate = false;
      if (line.startsWith("!")) {
        negate = true;
        line = line.slice(1);
      }

      // `/` final restringe a diretórios, mas o sufixo abaixo já casa
      // diretório + conteúdo; basta remover a barra.
      if (line.endsWith("/")) line = line.slice(0, -1);
      if (!line) continue;

      const anchored = line.startsWith("/");
      if (anchored) line = line.slice(1);
      const hasSlash = line.includes("/");
      const body = globToRegex(line);
      const prefix = anchored || hasSlash ? "^" : "(?:^|.*/)";
      // Casa o próprio caminho e tudo que estiver dentro dele.
      const suffix = "(?:/.*)?$";
      try {
        rules.push({ negate, regex: new RegExp(prefix + body + suffix) });
      } catch {
        // Padrão inválido: ignora a linha em vez de derrubar o walker.
      }
    }
  } catch {
    // Sem .gitignore: nenhuma regra.
  }

  return (relPath: string, _isDir: boolean): boolean => {
    const rel = relPath.replace(/\\/g, "/");
    let ignored = false;
    for (const rule of rules) {
      if (rule.regex.test(rel)) ignored = !rule.negate;
    }
    return ignored;
  };
}

/** Checa bytes nulos/estranhos para não indexar binário disfarçado. */
function looksBinary(abs: string): boolean {
  let fd: number | null = null;
  try {
    fd = fs.openSync(abs, "r");
    const buf = Buffer.alloc(4096);
    const read = fs.readSync(fd, buf, 0, buf.length, 0);
    if (read === 0) return false;
    let suspicious = 0;
    for (let i = 0; i < read; i++) {
      const byte = buf[i] ?? 0;
      if (byte === 0) return true;
      if (byte < 7 || (byte > 13 && byte < 32)) suspicious++;
    }
    return suspicious / read > 0.3;
  } catch {
    return true;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignora
      }
    }
  }
}

export interface WalkOptions {
  root: string;
  /** Número máximo de arquivos indexáveis (padrão 4000). */
  maxFiles?: number;
  /** Tamanho máximo por arquivo em bytes (padrão 512 KiB). */
  maxFileBytes?: number;
  /** Padrões extras de diretório para ignorar. */
  extraIgnoreDirs?: string[];
}

export interface WalkedFile {
  /** Caminho relativo ao root, com "/". */
  path: string;
  /** Caminho absoluto no disco. */
  abs: string;
  bytes: number;
  lang: string;
}

/**
 * Varre `root` recursivamente e devolve arquivos indexáveis em ordem
 * alfabética, respeitando ignores e limites.
 */
export function walkRepo(options: WalkOptions): WalkedFile[] {
  const root = path.resolve(options.root);
  const maxFiles = Math.max(1, options.maxFiles ?? 4000);
  const maxFileBytes = Math.max(1, options.maxFileBytes ?? 512 * 1024);
  const ignore = loadGitignore(root);
  const extraDirs = new Set(
    (options.extraIgnoreDirs ?? []).map((d) => d.toLowerCase()),
  );

  const out: WalkedFile[] = [];

  const visit = (relDir: string): void => {
    if (out.length >= maxFiles) return;

    const absDir = relDir
      ? path.join(root, relDir.split("/").join(path.sep))
      : root;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (out.length >= maxFiles) return;
      if (entry.isSymbolicLink()) continue;

      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      const lower = entry.name.toLowerCase();

      if (entry.isDirectory()) {
        if (DEFAULT_IGNORE_DIRS.has(lower) || extraDirs.has(lower)) continue;
        if (ignore(rel, true)) continue;
        visit(rel);
        continue;
      }

      if (!entry.isFile()) continue;
      if (ignore(rel, false)) continue;

      const lang = detectLang(entry.name);
      if (!lang) continue;

      const abs = path.join(root, rel.split("/").join(path.sep));
      let stat: fs.Stats;
      try {
        stat = fs.statSync(abs);
      } catch {
        continue;
      }
      if (!stat.isFile() || stat.size === 0 || stat.size > maxFileBytes) {
        continue;
      }
      if (looksBinary(abs)) continue;

      out.push({ path: rel, abs, bytes: stat.size, lang });
    }
  };

  visit("");
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}
