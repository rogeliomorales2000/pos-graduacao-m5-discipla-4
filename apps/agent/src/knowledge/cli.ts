#!/usr/bin/env node
/**
 * CLI do pipeline de conhecimento de segurança.
 *
 * Comandos:
 *   fetch     --days 30 --max 200 [--api-key ...]
 *   exploitdb --csv <files_exploits.csv>
 *   build     --out dataset/security
 *   stats
 *   search    --cve CVE-2021-44228
 *
 * Sempre há um caminho offline: quando o NVD falha, o seed local é usado.
 */

import fs from "node:fs";
import path from "node:path";
import type { CveRecord, EdbRecord } from "./types";
import {
  DEFAULT_CACHE_DIR,
  fetchCves,
  loadCache,
  mergeCves,
} from "./cve";
import {
  edbUrl,
  parseExploitDbCsv,
  parseExploitDbJson,
  searchEdb,
} from "./exploitdb";
import {
  CWE_DESCRIPTIONS,
  buildKnowledgeSamples,
  datasetStats,
  readManifest,
  writeKnowledgeDataset,
} from "./build";
import { seedCves } from "./seed";

interface ParsedArgs {
  command: string;
  flags: Record<string, string | boolean>;
  positionals: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = "help", ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg.startsWith("--")) {
      const [key, inline] = arg.slice(2).split("=", 2);
      if (inline !== undefined) {
        flags[key] = inline;
      } else if (rest[i + 1] && !rest[i + 1].startsWith("--")) {
        flags[key] = rest[i + 1];
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positionals.push(arg);
    }
  }

  return { command, flags, positionals };
}

function textFlag(flags: Record<string, string | boolean>, name: string): string | undefined {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}

function numberFlag(
  flags: Record<string, string | boolean>,
  name: string,
  fallback: number,
): number {
  const raw = textFlag(flags, name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function defaultOut(flags: Record<string, string | boolean>): string {
  return path.resolve(textFlag(flags, "out") ?? path.join("dataset", "security"));
}

function loadEdb(outDir: string): EdbRecord[] {
  const file = path.join(outDir, "edb", "records.json");
  try {
    return parseExploitDbJson(fs.readFileSync(file, "utf8"));
  } catch {
    return [];
  }
}

function loadCves(cacheDir: string): { records: CveRecord[]; source: "cache" | "seed" } {
  const cached = loadCache(cacheDir);
  if (cached.length > 0) return { records: mergeCves(cached), source: "cache" };
  return { records: seedCves(), source: "seed" };
}

async function cmdFetch(flags: Record<string, string | boolean>): Promise<void> {
  const days = numberFlag(flags, "days", 30);
  const max = numberFlag(flags, "max", 200);
  const startIndex = numberFlag(flags, "start-index", 0);
  const apiKey = textFlag(flags, "api-key") ?? process.env.NVD_API_KEY;
  const cacheDir = textFlag(flags, "cache-dir");

  try {
    const records = await fetchCves({ days, max, apiKey, startIndex, cacheDir });
    console.log(
      `NVD: ${records.length} CVE(s) normalizados (janela de ${days} dia(s), início ${startIndex}).`,
    );
    console.log(`Cache: ${path.resolve(cacheDir ?? DEFAULT_CACHE_DIR)}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Falha ao consultar o NVD: ${message}`);
    const fallback = seedCves();
    console.log(
      `Modo offline: usando ${fallback.length} CVE(s) do seed. Execute "build --out dataset/security" para gerar o dataset.`,
    );
  }
}

function cmdExploitdb(flags: Record<string, string | boolean>): void {
  const csv = textFlag(flags, "csv");
  const json = textFlag(flags, "json");
  const source = csv ?? json;

  if (!source) {
    console.log("Uso: exploitdb --csv <files_exploits.csv> [--out dataset/security/edb]");
    console.log("     exploitdb --json <indice.json> [--out dataset/security/edb]");
    console.log("Somente metadados são lidos; o campo file nunca é baixado.");
    return;
  }

  const file = path.resolve(source);
  if (!fs.existsSync(file)) {
    console.error(`Arquivo não encontrado: ${file}`);
    process.exitCode = 1;
    return;
  }

  const text = fs.readFileSync(file, "utf8");
  const records = csv ? parseExploitDbCsv(text) : parseExploitDbJson(text);
  const outDir = path.resolve(
    textFlag(flags, "out") ?? path.join("dataset", "security", "edb"),
  );
  fs.mkdirSync(outDir, { recursive: true });
  const target = path.join(outDir, "records.json");
  fs.writeFileSync(target, JSON.stringify(records, null, 2) + "\n", "utf8");

  const withCve = records.filter((record) => record.cveCodes.length > 0).length;
  console.log(
    `ExploitDB: ${records.length} registro(s) indexado(s), ${withCve} com CVE associado.`,
  );
  console.log(`Índice salvo em ${target} (nenhum arquivo de exploit foi baixado).`);
}

function cmdBuild(flags: Record<string, string | boolean>): void {
  const outDir = defaultOut(flags);
  const cacheDir = path.resolve(textFlag(flags, "cve-cache") ?? DEFAULT_CACHE_DIR);
  const cveState = loadCves(cacheDir);
  const edb = loadEdb(outDir);

  const samples = buildKnowledgeSamples({
    cves: cveState.records,
    edb,
    cweDescriptions: CWE_DESCRIPTIONS,
  });
  const manifest = writeKnowledgeDataset(samples, outDir);

  console.log(`Fonte CVE: ${cveState.source} (${cveState.records.length} registro(s)).`);
  console.log(`ExploitDB: ${edb.length} registro(s) de índice.`);
  console.log(`Amostras: ${manifest.total}`);
  console.log(
    `Splits: train=${manifest.splits.train} validation=${manifest.splits.validation} test=${manifest.splits.test}`,
  );
  console.log(
    `Proporções: train=${(manifest.ratios.train * 100).toFixed(1)}% validation=${(
      manifest.ratios.validation * 100
    ).toFixed(1)}% test=${(manifest.ratios.test * 100).toFixed(1)}%`,
  );
  console.log(`Manifest: ${path.join(outDir, "manifest.json")}`);
}

function cmdStats(flags: Record<string, string | boolean>): void {
  const outDir = defaultOut(flags);
  const stats = datasetStats(outDir);
  const manifest = stats.manifest ?? readManifest(outDir);

  if (!manifest && stats.counts.total === 0) {
    console.log(`Nenhum dataset encontrado em ${outDir}. Execute "build --out ${outDir}".`);
    return;
  }

  console.log(`Dataset: ${outDir}`);
  console.log(
    `Amostras: ${stats.counts.total} (train=${stats.counts.train} validation=${stats.counts.validation} test=${stats.counts.test})`,
  );
  if (manifest) {
    console.log(`Criado em: ${manifest.createdAt}`);
    console.log(`Formato: ${manifest.format}; defensivo: ${manifest.defensive}`);
    console.log(`Fontes: ${JSON.stringify(manifest.sources)}`);
  }
  console.log(`ExploitDB indexado: ${loadEdb(outDir).length} registro(s).`);
}

function cmdSearch(flags: Record<string, string | boolean>): void {
  const cveId = textFlag(flags, "cve")?.trim().toUpperCase();
  const q = textFlag(flags, "q")?.trim().toLowerCase();
  if (!cveId && !q) {
    console.log("Uso: search --cve CVE-2021-44228");
    console.log("     search --q \"path traversal\"");
    return;
  }

  const outDir = defaultOut(flags);
  const cacheDir = path.resolve(textFlag(flags, "cve-cache") ?? DEFAULT_CACHE_DIR);
  const cves = mergeCves([...seedCves(), ...loadCache(cacheDir)]);
  const edb = loadEdb(outDir);

  let matches = cves;
  if (cveId) matches = matches.filter((cve) => cve.id === cveId);
  if (q) {
    matches = matches.filter((cve) =>
      `${cve.id} ${cve.description} ${cve.cwes.join(" ")} ${cve.products
        .map((product) => `${product.vendor} ${product.product}`)
        .join(" ")}`
        .toLowerCase()
        .includes(q),
    );
  }

  if (matches.length === 0) {
    console.log("Nenhum CVE encontrado no seed/cache local.");
  } else {
    for (const cve of matches.slice(0, 10)) {
      console.log(`\n${cve.id} (${cve.cvss?.severity ?? "sem CVSS"})`);
      console.log(`Descrição: ${cve.description}`);
      console.log(
        `CVSS: ${cve.cvss ? `${cve.cvss.version} ${cve.cvss.score} ${cve.cvss.vector}` : "não informado"}`,
      );
      console.log(`CWE: ${cve.cwes.join(", ") || "não informado"}`);
      console.log(
        `Produtos: ${
          cve.products
            .map((product) => `${product.vendor}/${product.product} (${product.versions.join(", ")})`)
            .join("; ") || "não informados"
        }`,
      );
      if (cve.mitigation) console.log(`Mitigação: ${cve.mitigation}`);
      console.log(`Referências: ${cve.references.map((reference) => reference.url).join(", ")}`);
    }
  }

  const edbMatches = searchEdb(edb, { cve: cveId, q });
  console.log(`\nExploitDB (metadados): ${edbMatches.length} registro(s) correspondente(s).`);
  for (const record of edbMatches.slice(0, 10)) {
    console.log(`- ${record.id}: ${record.description} | ${edbUrl(record.id)}`);
  }
}

function printHelp(): void {
  console.log("M5 Agent — conhecimento de segurança (metadados públicos)");
  console.log("");
  console.log("Comandos:");
  console.log("  fetch --days 30 --max 200 [--api-key KEY] [--start-index N]");
  console.log("  exploitdb --csv <files_exploits.csv> [--out dataset/security/edb]");
  console.log("  build --out dataset/security");
  console.log("  stats");
  console.log("  search --cve CVE-2021-44228");
  console.log("");
  console.log("Offline: fetch cai para o seed e build funciona sem rede.");
  console.log("Nenhum exploit/PoC é baixado, armazenado ou gerado.");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  switch (args.command) {
    case "fetch":
      await cmdFetch(args.flags);
      break;
    case "exploitdb":
      cmdExploitdb(args.flags);
      break;
    case "build":
      cmdBuild(args.flags);
      break;
    case "stats":
      cmdStats(args.flags);
      break;
    case "search":
      cmdSearch(args.flags);
      break;
    case "help":
    case "--help":
    case "-h":
      printHelp();
      break;
    default:
      console.error(`Comando desconhecido: ${args.command}`);
      printHelp();
      process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
