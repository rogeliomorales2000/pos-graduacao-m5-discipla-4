import fs from "node:fs";
import path from "node:path";
import { Tool, ToolContext } from "../core/types";
import { resolveInside, toPosix, truncate } from "../core/util";

const IGNORE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", "coverage", ".next", ".m5",
  "models", ".cache", "target", "bin", "obj", ".venv", "venv", "__pycache__",
]);

export function matchGlob(pattern: string, candidate: string): boolean {
  const pat = toPosix(pattern).replace(/^\.\//, "");
  const file = toPosix(candidate).replace(/^\.\//, "");
  let regex = "";
  let i = 0;
  while (i < pat.length) {
    const ch = pat[i];
    if (ch === "*") {
      if (pat[i + 1] === "*") {
        i += 2;
        if (pat[i] === "/") {
          regex += "(?:.*/)?";
          i += 1;
        } else {
          regex += ".*";
        }
        continue;
      }
      regex += "[^/]*";
      i += 1;
      continue;
    }
    if (ch === "?") {
      regex += "[^/]";
      i += 1;
      continue;
    }
    if ("\\^$.|+()[]{}".includes(ch)) regex += `\\${ch}`;
    else regex += ch;
    i += 1;
  }
  return new RegExp(`^${regex}$`, "i").test(file);
}

export function walkFiles(
  root: string,
  options: { maxFiles?: number; maxFileBytes?: number; ignore?: Set<string> } = {},
): string[] {
  const maxFiles = options.maxFiles ?? 10_000;
  const maxBytes = options.maxFileBytes ?? 1_000_000;
  const ignore = options.ignore ?? IGNORE_DIRS;
  const out: string[] = [];

  const visit = (dir: string): void => {
    if (out.length >= maxFiles) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (out.length >= maxFiles) return;
      if (entry.name.startsWith(".git")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (ignore.has(entry.name)) continue;
        visit(full);
      } else if (entry.isFile()) {
        try {
          if (fs.statSync(full).size > maxBytes) continue;
        } catch {
          continue;
        }
        out.push(full);
      }
    }
  };

  visit(path.resolve(root));
  return out;
}

interface PathLookup {
  file: string;
  rel: string;
  correctedFrom?: string;
  suggestions: string[];
}

function normalizePathKey(value: string): string {
  return toPosix(value)
    .toLowerCase()
    .replace(/^\.\//, "")
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Sugere caminhos existentes quando o modelo erra hífen, caixa ou separador.
 * Ex.: `cli/minigpt/train.ts` -> `cli/mini-gpt/train.ts`.
 */
function pathSuggestions(ctx: ToolContext, raw: string): string[] {
  const wanted = toPosix(raw).replace(/^\.\//, "");
  const wantedBase = path.posix.basename(wanted).toLowerCase();
  const wantedKey = normalizePathKey(wanted);
  const scored: Array<{ rel: string; score: number }> = [];

  for (const file of walkFiles(ctx.workspace, { maxFiles: 50_000, maxFileBytes: 20_000_000 })) {
    const rel = toPosix(path.relative(ctx.workspace, file));
    const lower = rel.toLowerCase();
    const base = path.posix.basename(rel).toLowerCase();
    const key = normalizePathKey(rel);
    let score = 0;
    if (lower === wanted.toLowerCase()) score = 100;
    else if (key === wantedKey) score = 90;
    else if (base === wantedBase) score = 70;
    else if (wantedBase && (base.includes(wantedBase) || wantedBase.includes(base))) score = 40;
    else if (wantedKey && (key.includes(wantedKey) || wantedKey.includes(key))) score = 20;
    if (score > 0) scored.push({ rel, score });
  }

  scored.sort((a, b) => b.score - a.score || a.rel.length - b.rel.length);
  return scored.slice(0, 5).map((item) => item.rel);
}

function lookupPath(
  ctx: ToolContext,
  raw: unknown,
  options: { autoCorrect?: boolean } = {},
): PathLookup {
  const value = typeof raw === "string" && raw.length > 0 ? raw : ".";
  const relInput = toPosix(value).replace(/^\.\//, "");
  const direct = resolveInside(ctx.workspace, relInput);
  if (fs.existsSync(direct)) {
    return { file: direct, rel: toPosix(path.relative(ctx.workspace, direct)), suggestions: [] };
  }

  const suggestions = pathSuggestions(ctx, relInput);
  if (options.autoCorrect) {
    const wantedKey = normalizePathKey(relInput);
    const exact = suggestions.filter((rel) => normalizePathKey(rel) === wantedKey);
    if (exact.length === 1) {
      return {
        file: resolveInside(ctx.workspace, exact[0]),
        rel: exact[0],
        correctedFrom: relInput,
        suggestions,
      };
    }
  }
  return { file: direct, rel: relInput, suggestions };
}

function pathHint(suggestions: string[]): string {
  if (suggestions.length === 0) return "";
  return `\nSugestões de caminho:\n${suggestions.map((rel) => `- ${rel}`).join("\n")}`;
}

function correctedNote(lookup: PathLookup): string {
  return lookup.correctedFrom
    ? `[caminho corrigido: ${lookup.correctedFrom} -> ${lookup.rel}]\n`
    : "";
}

/**
 * Copia o arquivo antes de sobrescrever/editar. Não bloqueia a ação; só
 * garante que uma escrita errada do modelo possa ser desfeita.
 */
function backupExisting(ctx: ToolContext, file: string): string | null {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
  const rel = toPosix(path.relative(ctx.workspace, file));
  if (rel.startsWith(".m5/")) return null;

  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const backup = path.join(ctx.workspace, ".m5", "backups", ctx.sessionId, stamp, rel);
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  fs.copyFileSync(file, backup);
  return toPosix(path.relative(ctx.workspace, backup));
}

export const readFileTool: Tool = {
  spec: {
    name: "read_file",
    group: "fs",
    description:
      "Lê um arquivo do workspace. Use start/end (1-based, inclusivo) para trechos grandes. Retorna linhas numeradas.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Caminho relativo ao workspace." },
        start: { type: "integer", description: "Linha inicial (1-based)." },
        end: { type: "integer", description: "Linha final (inclusiva)." },
      },
      required: ["path"],
    },
  },
  async run(input, ctx) {
    const lookup = lookupPath(ctx, input.path, { autoCorrect: true });
    const file = lookup.file;
    if (!fs.existsSync(file)) {
      return { ok: false, output: `Arquivo não encontrado: ${input.path}${pathHint(lookup.suggestions)}` };
    }
    if (fs.statSync(file).isDirectory()) {
      return { ok: false, output: `É um diretório: ${input.path}${pathHint(lookup.suggestions)}` };
    }
    const raw = fs.readFileSync(file, "utf8");
    const lines = raw.split(/\r?\n/);
    const start = Math.max(1, Number(input.start ?? 1));
    const end = Math.min(lines.length, Number(input.end ?? lines.length));
    const width = String(end).length;
    const body = lines
      .slice(start - 1, end)
      .map((line, idx) => `${String(start + idx).padStart(width)}: ${line}`)
      .join("\n");
    const note = lines.length > end ? `\n[... ${lines.length - end} linhas restantes]` : "";
    return {
      ok: true,
      output: truncate(correctedNote(lookup) + body + note, ctx.config.limits.maxToolOutputChars),
      meta: lookup.correctedFrom
        ? { resolvedFrom: lookup.correctedFrom, resolvedTo: lookup.rel }
        : undefined,
    };
  },
};

export const writeFileTool: Tool = {
  spec: {
    name: "write_file",
    group: "fs",
    dangerous: true,
    description:
      "Cria ou sobrescreve um arquivo com o conteúdo completo. Prefira patch_file para edições pontuais.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Caminho relativo ao workspace." },
        content: { type: "string", description: "Conteúdo completo do arquivo." },
      },
      required: ["path", "content"],
    },
  },
  async run(input, ctx) {
    const lookup = lookupPath(ctx, input.path, { autoCorrect: true });
    const file = lookup.file;
    const content = String(input.content ?? "");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const existed = fs.existsSync(file);
    const backup = backupExisting(ctx, file);
    fs.writeFileSync(file, content, "utf8");
    ctx.log(`write_file ${existed ? "sobrescreveu" : "criou"} ${lookup.rel}`, {
      bytes: Buffer.byteLength(content),
      ...(backup ? { backup } : {}),
      ...(lookup.correctedFrom ? { resolvedFrom: lookup.correctedFrom } : {}),
    });
    return {
      ok: true,
      output: `${existed ? "Sobrescrito" : "Criado"}: ${lookup.rel} (${Buffer.byteLength(content)} bytes)${backup ? `\n[backup: ${backup}]` : ""}${lookup.correctedFrom ? `\n[path corrigido: ${lookup.correctedFrom} -> ${lookup.rel}]` : ""}`,
      meta: { changed: lookup.rel, ...(backup ? { backup } : {}) },
    };
  },
};

export const patchFileTool: Tool = {
  spec: {
    name: "patch_file",
    group: "fs",
    dangerous: true,
    description:
      "Substitui um trecho exato de um arquivo. oldString precisa aparecer exatamente uma vez, salvo replaceAll=true.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Caminho relativo ao workspace." },
        oldString: { type: "string", description: "Trecho exato a localizar (inclua indentação)." },
        newString: { type: "string", description: "Trecho substituto." },
        replaceAll: { type: "boolean", description: "Substitui todas as ocorrências." },
      },
      required: ["path", "oldString", "newString"],
    },
  },
  async run(input, ctx) {
    const lookup = lookupPath(ctx, input.path, { autoCorrect: true });
    const file = lookup.file;
    if (!fs.existsSync(file)) {
      return { ok: false, output: `Arquivo não encontrado: ${input.path}${pathHint(lookup.suggestions)}` };
    }
    const original = fs.readFileSync(file, "utf8");
    const oldString = String(input.oldString ?? "");
    const newString = String(input.newString ?? "");
    if (!oldString) return { ok: false, output: "oldString vazio." };
    if (oldString === newString) return { ok: false, output: "oldString e newString são idênticos." };

    // Modelos pequenos costumam copiar o conteúdo com \n mesmo quando o
    // arquivo está em CRLF (Windows). Tenta o match exato e depois normaliza
    // apenas as quebras de linha, preservando o EOL original ao salvar.
    let source = original;
    let matchOld = oldString;
    let matchNew = newString;
    let occurrences = source.split(matchOld).length - 1;
    if (occurrences === 0) {
      const normalizedOriginal = original.replace(/\r\n/g, "\n");
      const normalizedOld = oldString.replace(/\r\n/g, "\n");
      const normalizedNew = newString.replace(/\r\n/g, "\n");
      const normalizedOccurrences = normalizedOriginal.split(normalizedOld).length - 1;
      if (normalizedOccurrences > 0) {
        source = normalizedOriginal;
        matchOld = normalizedOld;
        matchNew = normalizedNew;
        occurrences = normalizedOccurrences;
      }
    }
    if (occurrences === 0) {
      return {
        ok: false,
        output:
          `Trecho não encontrado em ${lookup.rel}. Releia o arquivo e tente de novo. `
          + "Dica: o trecho deve existir exatamente; quebras de linha LF/CRLF são toleradas.",
      };
    }
    const replaceAll = input.replaceAll === true;
    if (occurrences > 1 && !replaceAll) {
      return {
        ok: false,
        output: `Trecho aparece ${occurrences} vezes. Inclua mais contexto ou use replaceAll=true.`,
      };
    }
    const replaced = replaceAll
      ? source.split(matchOld).join(matchNew)
      : source.replace(matchOld, matchNew);
    const updated = source === original
      ? replaced
      : original.includes("\r\n")
        ? replaced.replace(/\n/g, "\r\n")
        : replaced;
    const backup = backupExisting(ctx, file);
    fs.writeFileSync(file, updated, "utf8");
    ctx.log(`patch_file ${lookup.rel}`, {
      occurrences,
      replaceAll,
      ...(backup ? { backup } : {}),
      ...(lookup.correctedFrom ? { resolvedFrom: lookup.correctedFrom } : {}),
    });
    return {
      ok: true,
      output: `Editado ${lookup.rel} (${occurrences} ocorrência(s)).${backup ? `\n[backup: ${backup}]` : ""}${lookup.correctedFrom ? `\n[path corrigido: ${lookup.correctedFrom} -> ${lookup.rel}]` : ""}`,
      meta: { changed: lookup.rel, ...(backup ? { backup } : {}) },
    };
  },
};

export const listDirTool: Tool = {
  spec: {
    name: "list_dir",
    group: "fs",
    description: "Lista arquivos e diretórios. depth=1 por padrão.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        depth: { type: "integer", description: "Profundidade máxima (1-4)." },
      },
    },
  },
  async run(input, ctx) {
    const lookup = lookupPath(ctx, input.path, { autoCorrect: true });
    const root = lookup.file;
    if (!fs.existsSync(root)) {
      return { ok: false, output: `Diretório não encontrado: ${input.path}${pathHint(lookup.suggestions)}` };
    }
    if (!fs.statSync(root).isDirectory()) {
      return { ok: false, output: `Não é um diretório: ${input.path}${pathHint(lookup.suggestions)}` };
    }
    const maxDepth = Math.min(4, Math.max(1, Number(input.depth ?? 1)));
    const lines: string[] = [];
    if (lookup.correctedFrom) {
      lines.push(`[caminho corrigido: ${lookup.correctedFrom} -> ${lookup.rel}]`);
    }
    const visit = (dir: string, prefix: string, depth: number): void => {
      if (depth > maxDepth) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (IGNORE_DIRS.has(entry.name)) {
          lines.push(`${prefix}${entry.name}/ (ignorado)`);
          continue;
        }
        lines.push(`${prefix}${entry.name}${entry.isDirectory() ? "/" : ""}`);
        if (entry.isDirectory()) visit(path.join(dir, entry.name), `${prefix}  `, depth + 1);
      }
    };
    visit(root, "", 1);
    return { ok: true, output: truncate(lines.join("\n"), ctx.config.limits.maxToolOutputChars) };
  },
};

export const globTool: Tool = {
  spec: {
    name: "glob",
    group: "fs",
    description: "Encontra arquivos por padrão glob (ex.: src/**/*.ts). Ignora node_modules e .git.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Padrão glob relativo ao workspace." },
        limit: { type: "integer", description: "Máximo de resultados (padrão 200)." },
      },
      required: ["pattern"],
    },
  },
  async run(input, ctx) {
    const pattern = String(input.pattern ?? "");
    const limit = Math.max(1, Number(input.limit ?? 200));
    const files = walkFiles(ctx.workspace, { maxFiles: 20_000, maxFileBytes: 5_000_000 });
    const hits = files
      .map((f) => toPosix(path.relative(ctx.workspace, f)))
      .filter((rel) => matchGlob(pattern, rel))
      .slice(0, limit);
    return { ok: true, output: hits.length ? hits.join("\n") : "Nenhum arquivo encontrado." };
  },
};

export const grepTool: Tool = {
  spec: {
    name: "grep",
    group: "fs",
    description:
      "Busca em conteúdo com regex. Retorna arquivo:linha:texto. Use include para filtrar (ex.: *.ts).",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Expressão regular (JS)." },
        path: { type: "string", description: "Diretório/arquivo base. Padrão: workspace." },
        include: { type: "string", description: "Glob de arquivos (ex.: *.ts)." },
        limit: { type: "integer", description: "Máximo de linhas (padrão 100)." },
        caseSensitive: { type: "boolean" },
      },
      required: ["pattern"],
    },
  },
  async run(input, ctx) {
    const limit = Math.max(1, Number(input.limit ?? 100));
    const flags = input.caseSensitive === true ? "" : "i";
    let regex: RegExp;
    try {
      regex = new RegExp(String(input.pattern), flags);
    } catch (err) {
      return { ok: false, output: `Regex inválida: ${(err as Error).message}` };
    }
    const lookup = lookupPath(ctx, input.path, { autoCorrect: true });
    const base = lookup.file;
    if (typeof input.path === "string" && !fs.existsSync(base)) {
      return { ok: false, output: `Caminho não encontrado: ${input.path}${pathHint(lookup.suggestions)}` };
    }
    const include = typeof input.include === "string" ? input.include : null;
    const files = fs.existsSync(base) && fs.statSync(base).isFile()
      ? [base]
      : walkFiles(base, { maxFiles: 20_000, maxFileBytes: 2_000_000 });
    const hits: string[] = [];
    for (const file of files) {
      if (include && !matchGlob(include, toPosix(path.relative(base, file))) && !matchGlob(include, path.basename(file))) {
        continue;
      }
      let text: string;
      try {
        text = fs.readFileSync(file, "utf8");
      } catch {
        continue;
      }
      if (text.includes("\u0000")) continue;
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          hits.push(`${toPosix(path.relative(ctx.workspace, file))}:${i + 1}:${lines[i].slice(0, 300)}`);
          if (hits.length >= limit) break;
        }
      }
      if (hits.length >= limit) break;
    }
    return {
      ok: true,
      output: `${correctedNote(lookup)}${hits.length ? hits.join("\n") : "Nenhuma ocorrência."}`,
      meta: { count: hits.length },
    };
  },
};

/**
 * Paths fora do workspace lançam em `resolveInside`. Em vez de derrubar o
 * agente, convertemos a exceção em resultado de tool com ok=false.
 */
function guardTool(tool: Tool): void {
  const original = tool.run.bind(tool);
  tool.run = async (input, ctx) => {
    try {
      return await original(input, ctx);
    } catch (err) {
      return { ok: false, output: `Erro em ${tool.spec.name}: ${(err as Error).message}` };
    }
  };
}

for (const tool of [readFileTool, writeFileTool, patchFileTool, listDirTool, globTool, grepTool]) {
  guardTool(tool);
}
