/**
 * CLI do indexador.
 *
 * Uso:
 *   tsx apps/agent/src/index/cli.ts build   [--root .] [--max-files 400] [--max-file-bytes N] [--store path] [--no-cache]
 *   tsx apps/agent/src/index/cli.ts stats   [--root .] [--store path]
 *   tsx apps/agent/src/index/cli.ts search  "consulta" [--limit 10] [--lang ts] [--path src/] [--root .]
 *   tsx apps/agent/src/index/cli.ts map     [--max-files 200] [--max-chars 12000]
 *   tsx apps/agent/src/index/cli.ts symbols <arquivo>
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { findSymbols, search } from "./query";
import { renderRepoMap } from "./repoMap";
import {
  buildIndex,
  defaultStorePath,
  indexStats,
  loadIndex,
  saveIndex,
  type IndexStats,
} from "./store";
import type { CodeIndex } from "./types";

type FlagValue = string | boolean;
type Flags = Record<string, FlagValue>;

interface ParsedArgs {
  positional: string[];
  flags: Flags;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Flags = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    if (eq >= 0) {
      flags[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[body] = next;
      i++;
    } else {
      flags[body] = true;
    }
  }

  return { positional, flags };
}

function stringFlag(flags: Flags, name: string): string | undefined {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}

function numberFlag(flags: Flags, name: string, fallback: number): number {
  const value = stringFlag(flags, name);
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolFlag(flags: Flags, name: string): boolean {
  const value = flags[name];
  return value === true || value === "true" || value === "1";
}

function rootFrom(flags: Flags): string {
  return path.resolve(stringFlag(flags, "root") ?? process.cwd());
}

function storeFrom(flags: Flags, root: string): string {
  const configured = stringFlag(flags, "store");
  return configured ? path.resolve(configured) : defaultStorePath(root);
}

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function printStats(stats: IndexStats, store: string): void {
  console.log(`Root:       ${stats.root}`);
  console.log(
    `Arquivos:   ${stats.files} indexados` +
      (stats.meta
        ? ` (${stats.meta.reused} reusados, ${stats.meta.changed} novos/alterados, ${stats.meta.removed} removidos)`
        : ""),
  );
  console.log(`Conteúdo:   ${fmtBytes(stats.bytes)} · ${stats.lines} linhas`);
  console.log(
    `Estrutura:  ${stats.symbols} símbolos · ${stats.chunks} chunks · ${stats.vectors} vetores (dim ${stats.vectorDim})`,
  );
  const langs = Object.entries(stats.languages)
    .sort((a, b) => b[1] - a[1])
    .map(([lang, count]) => `${lang}=${count}`)
    .join(" ");
  console.log(`Linguagens: ${langs || "(nenhuma)"}`);
  console.log(`Criado em:  ${stats.createdAt}`);
  if (stats.meta) console.log(`Tempo:      ${stats.meta.durationMs} ms`);
  console.log(`Store:      ${store}`);
}

/** Carrega o índice; se não existir, constrói e salva automaticamente. */
function openIndex(root: string, store: string, flags: Flags): CodeIndex {
  const existing = loadIndex(store);
  if (existing) return existing;

  console.log(`(índice ausente em ${store} — construindo agora)`);
  const index = buildIndex({
    root,
    maxFiles: numberFlag(flags, "max-files", 4000),
    maxFileBytes: numberFlag(flags, "max-file-bytes", 512 * 1024),
    storePath: store,
    useCache: false,
  });
  saveIndex(index, store);
  return index;
}

function commandBuild(flags: Flags): number {
  const root = rootFrom(flags);
  const store = storeFrom(flags, root);
  const useCache = !boolFlag(flags, "no-cache");

  const index = buildIndex({
    root,
    maxFiles: numberFlag(flags, "max-files", 4000),
    maxFileBytes: numberFlag(flags, "max-file-bytes", 512 * 1024),
    storePath: store,
    useCache,
  });
  const saved = saveIndex(index, store);
  console.log("Índice construído.\n");
  printStats(indexStats(index), saved);
  return 0;
}

function commandStats(flags: Flags): number {
  const root = rootFrom(flags);
  const store = storeFrom(flags, root);
  const index = loadIndex(store);
  if (!index) {
    console.error(`Nenhum índice em ${store}. Rode "build" primeiro.`);
    return 1;
  }
  printStats(indexStats(index), store);
  return 0;
}

function commandSearch(flags: Flags, positional: string[]): number {
  const query = positional.join(" ").trim();
  if (!query) {
    console.error('Uso: search "consulta" [--limit 10] [--lang ts] [--path src/]');
    return 1;
  }

  const root = rootFrom(flags);
  const store = storeFrom(flags, root);
  const index = openIndex(root, store, flags);

  const hits = search(index, query, {
    limit: numberFlag(flags, "limit", 10),
    lang: stringFlag(flags, "lang"),
    pathPrefix: stringFlag(flags, "path"),
    perFile: numberFlag(flags, "per-file", 2),
  });

  if (hits.length === 0) {
    console.log(`Nenhum resultado para "${query}".`);
    return 0;
  }

  console.log(`${hits.length} resultado(s) para "${query}":`);
  hits.forEach((hit, i) => {
    console.log(
      `\n#${i + 1}  score=${hit.score.toFixed(4)}  ${hit.path}:${hit.startLine}-${hit.endLine}`,
    );
    if (hit.symbols.length > 0) {
      console.log(`    símbolos: ${hit.symbols.join(", ")}`);
    }
    const snippetLines = hit.snippet.split("\n");
    for (const line of snippetLines.slice(0, 8)) console.log(`    ${line}`);
    if (snippetLines.length > 8) console.log("    …");
  });
  return 0;
}

function commandMap(flags: Flags): number {
  const root = rootFrom(flags);
  const store = storeFrom(flags, root);
  const index = openIndex(root, store, flags);
  console.log(
    renderRepoMap(index, {
      maxFiles: numberFlag(flags, "max-files", 200),
      maxChars: numberFlag(flags, "max-chars", 12000),
      symbolsPerFile: numberFlag(flags, "symbols-per-file", 8),
    }),
  );
  return 0;
}

function commandSymbols(flags: Flags, positional: string[]): number {
  const wanted = (positional[0] ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
  if (!wanted) {
    console.error("Uso: symbols <arquivo>");
    return 1;
  }

  const root = rootFrom(flags);
  const store = storeFrom(flags, root);
  const index = openIndex(root, store, flags);

  const file =
    index.files.find((f) => f.path === wanted) ??
    index.files.find((f) => f.path.endsWith("/" + wanted));

  if (!file) {
    console.error(`Arquivo não encontrado no índice: ${wanted}`);
    const suggestions = findSymbols(index, wanted, 5);
    if (suggestions.length > 0) {
      console.error("Talvez você quis dizer:");
      for (const symbol of suggestions) {
        console.error(`  ${symbol.kind} ${symbol.name} (${symbol.file}:${symbol.line})`);
      }
    }
    return 1;
  }

  console.log(`${file.path} — ${file.symbols.length} símbolo(s), ${file.lines} linha(s), ${file.lang}`);
  for (const symbol of file.symbols) {
    console.log(`  ${symbol.kind.padEnd(9)} ${symbol.name}  :${symbol.line}`);
  }
  return 0;
}

function printHelp(): void {
  console.log(`Indexador de código do M5 Agent

Comandos:
  build     Constrói/salva o índice (incremental por sha1)
  stats     Mostra estatísticas do índice salvo
  search    Busca híbrida (lexical + vetor + símbolos)
  map       Renderiza o mapa do repositório para o prompt
  symbols   Lista símbolos de um arquivo

Flags comuns:
  --root <dir>            Raiz do repositório (padrão: cwd)
  --store <arquivo>       Caminho do índice (padrão: <root>/.m5/code-index.json)
  --max-files <n>         Limite de arquivos (build: 4000, map: 200)
  --max-file-bytes <n>    Tamanho máximo por arquivo
  --no-cache              Ignora o índice anterior no build
  --limit <n>             Resultados da busca
  --lang <lang>           Filtra busca por linguagem
  --path <prefixo>        Filtra busca por prefixo de caminho
  --max-chars <n>         Orçamento do mapa
`);
}

function main(argv: string[]): number {
  const { positional, flags } = parseArgs(argv);
  const command = positional.shift() ?? "help";

  switch (command) {
    case "build":
      return commandBuild(flags);
    case "stats":
      return commandStats(flags);
    case "search":
      return commandSearch(flags, positional);
    case "map":
      return commandMap(flags);
    case "symbols":
      return commandSymbols(flags, positional);
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return 0;
    default:
      console.error(`Comando desconhecido: ${command}`);
      printHelp();
      return 1;
  }
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return path.resolve(fileURLToPath(import.meta.url)) === path.resolve(entry);
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  process.exitCode = main(process.argv.slice(2));
}
