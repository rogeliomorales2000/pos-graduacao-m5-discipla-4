/**
 * Tools de navegação semântica do workspace.
 *
 * `search_code`, `find_symbols` e `repo_map` operam sobre o índice local
 * (`.m5/code-index.json`). Quando o índice não existe, ele é construído na
 * primeira chamada; `index_build` força uma reconstrução explícita.
 */
import path from "node:path";
import { Tool, ToolContext, ToolResult } from "../core/types";
import { truncate } from "../core/util";
import { findSymbols, search } from "../index/query";
import { renderRepoMap } from "../index/repoMap";
import {
  buildIndex,
  defaultStorePath,
  indexStats,
  loadIndex,
  saveIndex,
} from "../index/store";
import type { CodeIndex } from "../index/types";

interface LoadedIndex {
  index: CodeIndex;
  store: string;
  built: boolean;
}

function storePath(ctx: ToolContext): string {
  const configured = ctx.config.index.storePath;
  return configured ? path.resolve(configured) : defaultStorePath(ctx.workspace);
}

function loadOrBuild(ctx: ToolContext, force: boolean): LoadedIndex {
  const store = storePath(ctx);
  if (!force) {
    const cached = loadIndex(store);
    if (cached) return { index: cached, store, built: false };
  }
  const started = Date.now();
  const index = buildIndex({
    root: ctx.workspace,
    storePath: store,
    maxFiles: ctx.config.index.maxFiles,
    maxFileBytes: ctx.config.index.maxFileBytes,
    useCache: !force,
  });
  saveIndex(index, store);
  const stats = indexStats(index);
  ctx.log("index:build", {
    files: stats.files,
    chunks: stats.chunks,
    symbols: stats.symbols,
    durationMs: Date.now() - started,
    forced: force,
  });
  return { index, store, built: true };
}

function numberInput(input: Record<string, unknown>, key: string, fallback: number): number {
  const raw = input[key];
  const value = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
  return Number.isFinite(value) ? value : fallback;
}

function stringInput(input: Record<string, unknown>, key: string): string | undefined {
  const raw = input[key];
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : undefined;
}

function formatHits(hits: ReturnType<typeof search>, maxChars: number): string {
  if (hits.length === 0) return "Nenhum trecho relevante encontrado.";
  const parts = hits.map((hit, index) => {
    const symbols = hit.symbols.length > 0 ? ` symbols=${hit.symbols.join(",")}` : "";
    return [
      `${index + 1}. ${hit.path}:${hit.startLine}-${hit.endLine} score=${hit.score}${symbols}`,
      hit.snippet,
    ].join("\n");
  });
  return truncate(parts.join("\n\n"), maxChars);
}

export const searchCodeTool: Tool = {
  spec: {
    name: "search_code",
    group: "fs",
    description:
      "Busca híbrida (lexical + embedding + símbolos) no código do workspace. Retorna arquivo, linhas, score e trecho. Use antes de ler arquivos grandes.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Linguagem natural ou identificador procurado." },
        limit: { type: "integer", description: "Máximo de trechos (padrão 10)." },
        lang: { type: "string", description: "Filtra por linguagem (ts, py, c, ...)." },
        path: { type: "string", description: "Filtra por prefixo de caminho (ex.: src/)." },
        per_file: { type: "integer", description: "Máximo de trechos por arquivo." },
        refresh: { type: "boolean", description: "Reconstrói o índice antes de buscar." },
      },
      required: ["query"],
    },
  },
  async run(input, ctx): Promise<ToolResult> {
    const query = stringInput(input, "query");
    if (!query) return { ok: false, output: "Parâmetro obrigatório: query." };
    const { index, built, store } = loadOrBuild(ctx, input.refresh === true);
    const hits = search(index, query, {
      limit: numberInput(input, "limit", 10),
      lang: stringInput(input, "lang"),
      pathPrefix: stringInput(input, "path"),
      perFile: numberInput(input, "per_file", 2),
    });
    const header = built
      ? `índice reconstruído (${index.files.length} arquivos) em ${store}\n`
      : `índice: ${index.files.length} arquivos\n`;
    return {
      ok: true,
      output: header + formatHits(hits, 14000),
      meta: { hits: hits.length, built, store },
    };
  },
};

export const findSymbolsTool: Tool = {
  spec: {
    name: "find_symbols",
    group: "fs",
    description:
      "Localiza definições por nome (função, classe, método, struct, trait) no índice do workspace.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Nome exato ou fragmento do símbolo." },
        limit: { type: "integer", description: "Máximo de símbolos (padrão 25)." },
        refresh: { type: "boolean", description: "Reconstrói o índice antes de buscar." },
      },
      required: ["name"],
    },
  },
  async run(input, ctx): Promise<ToolResult> {
    const name = stringInput(input, "name");
    if (!name) return { ok: false, output: "Parâmetro obrigatório: name." };
    const { index, built } = loadOrBuild(ctx, input.refresh === true);
    const symbols = findSymbols(index, name, numberInput(input, "limit", 25));
    if (symbols.length === 0) {
      return { ok: true, output: `Nenhum símbolo encontrado para "${name}".`, meta: { built } };
    }
    const lines = symbols.map(
      (symbol) => `${symbol.file}:${symbol.line} ${symbol.kind} ${symbol.name} — ${symbol.signature}`,
    );
    return { ok: true, output: truncate(lines.join("\n"), 10000), meta: { built, count: symbols.length } };
  },
};

export const repoMapTool: Tool = {
  spec: {
    name: "repo_map",
    group: "fs",
    description:
      "Gera um mapa compacto do repositório (árvore, linguagens, linhas e principais símbolos) para orientar a navegação.",
    parameters: {
      type: "object",
      properties: {
        max_files: { type: "integer", description: "Máximo de arquivos listados (padrão 200)." },
        max_chars: { type: "integer", description: "Orçamento de caracteres (padrão 12000)." },
        symbols_per_file: { type: "integer", description: "Símbolos por arquivo (padrão 8)." },
        refresh: { type: "boolean", description: "Reconstrói o índice antes de renderizar." },
      },
    },
  },
  async run(input, ctx): Promise<ToolResult> {
    const { index, built, store } = loadOrBuild(ctx, input.refresh === true);
    const map = renderRepoMap(index, {
      maxFiles: numberInput(input, "max_files", 200),
      maxChars: numberInput(input, "max_chars", 12000),
      symbolsPerFile: numberInput(input, "symbols_per_file", 8),
    });
    return {
      ok: true,
      output: truncate(map, numberInput(input, "max_chars", 12000) + 500),
      meta: { built, store, files: index.files.length },
    };
  },
};

export const indexBuildTool: Tool = {
  spec: {
    name: "index_build",
    group: "fs",
    description:
      "Reconstrói o índice de código do workspace e retorna estatísticas (arquivos, chunks, símbolos, linguagens).",
    parameters: {
      type: "object",
      properties: {
        max_files: { type: "integer", description: "Máximo de arquivos a indexar (padrão 4000)." },
      },
    },
  },
  async run(input, ctx): Promise<ToolResult> {
    const store = storePath(ctx);
    const started = Date.now();
    const index = buildIndex({
      root: ctx.workspace,
      maxFiles: numberInput(input, "max_files", ctx.config.index.maxFiles),
      maxFileBytes: ctx.config.index.maxFileBytes,
      storePath: store,
      useCache: false,
    });
    saveIndex(index, store);
    const stats = indexStats(index);
    ctx.log("index:build", { files: stats.files, durationMs: Date.now() - started, forced: true });
    const languages = Object.entries(stats.languages)
      .sort((left, right) => right[1] - left[1])
      .map(([lang, count]) => `${lang}=${count}`)
      .join(" ");
    return {
      ok: true,
      output: [
        `índice: ${store}`,
        `arquivos=${stats.files} linhas=${stats.lines} símbolos=${stats.symbols} chunks=${stats.chunks}`,
        `linguagens: ${languages || "(nenhuma)"}`,
      ].join("\n"),
      meta: { ...stats, store },
    };
  },
};

export const INDEX_TOOLS: Tool[] = [searchCodeTool, findSymbolsTool, repoMapTool, indexBuildTool];
