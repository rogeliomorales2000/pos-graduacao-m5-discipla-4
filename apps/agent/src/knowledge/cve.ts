/**
 * Cliente do feed NVD 2.0 (metadados públicos de CVE).
 *
 * - Paginação por `startIndex`, com retomada explícita.
 * - Rate limit conservador: 6s sem API key e 0,6s com API key.
 * - Retry com backoff exponencial para 403/429/503.
 * - Cache local em `dataset/security/cve/cache/nvd-<timestamp>.json`.
 * - Nenhuma referência é seguida e nenhum exploit/PoC é baixado.
 */

import fs from "node:fs";
import path from "node:path";
import type { CveProduct, CveRecord, CveReference, CvssInfo } from "./types";

export const NVD_API_URL = "https://services.nvd.nist.gov/rest/json/cves/2.0";
export const DEFAULT_CACHE_DIR = path.join("dataset", "security", "cve", "cache");
export const RATE_LIMIT_MS = { withKey: 600, withoutKey: 6000 } as const;

export interface FetchCvesOptions {
  /** Janela de publicação em dias. */
  days: number;
  /** Máximo de CVEs coletados nesta execução. */
  max: number;
  apiKey?: string;
  /** Índice inicial para retomar uma coleta anterior. */
  startIndex?: number;
  cacheDir?: string;
  /** Tamanho de página (NVD aceita até 2000). */
  resultsPerPage?: number;
}

interface NvdDescription {
  lang?: string;
  value?: string;
}

interface NvdMetricData {
  version?: string;
  vectorString?: string;
  baseScore?: number;
  baseSeverity?: string;
}

interface NvdMetric {
  cvssData?: NvdMetricData;
  baseSeverity?: string;
}

interface NvdWeakness {
  description?: NvdDescription[];
}

interface NvdCpeMatch {
  criteria?: string;
  vulnerable?: boolean;
}

interface NvdNode {
  cpeMatch?: NvdCpeMatch[];
  children?: NvdNode[];
}

interface NvdConfiguration {
  nodes?: NvdNode[];
}

interface NvdReference {
  url?: string;
  tags?: string[];
}

interface NvdCve {
  id?: string;
  sourceIdentifier?: string;
  published?: string;
  lastModified?: string;
  descriptions?: NvdDescription[];
  metrics?: Record<string, NvdMetric[] | undefined>;
  weaknesses?: NvdWeakness[];
  configurations?: NvdConfiguration[];
  references?: NvdReference[];
}

interface NvdItem {
  cve?: NvdCve;
}

interface NvdResponse {
  resultsPerPage?: number;
  startIndex?: number;
  totalResults?: number;
  vulnerabilities?: NvdItem[];
}

interface NvdCacheFile {
  fetchedAt: string;
  source: string;
  startIndex: number;
  totalResults: number;
  records: CveRecord[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function severityFromScore(score: number): string {
  if (score >= 9) return "CRITICAL";
  if (score >= 7) return "HIGH";
  if (score >= 4) return "MEDIUM";
  if (score > 0) return "LOW";
  return "NONE";
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Divide um CPE 2.3 respeitando escapes com barra invertida. */
function splitCpe(cpe: string): string[] {
  const parts: string[] = [];
  let current = "";
  let escaped = false;
  for (const char of cpe) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === ":") {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

/**
 * Extrai vendor/product/version de um CPE 2.3.
 * Retorna `null` para CPEs coringa ou inválidos.
 */
export function parseCpe(cpe: string): { vendor: string; product: string; version: string } | null {
  const parts = splitCpe(cpe.trim());
  if (parts.length < 6 || parts[0] !== "cpe" || parts[1] !== "2.3") return null;
  const vendor = safeDecode(parts[3]);
  const product = safeDecode(parts[4]);
  const rawVersion = safeDecode(parts[5]);
  if (!vendor || !product) return null;
  if (["*", "-", ""].includes(vendor) || ["*", "-", ""].includes(product)) return null;
  const version = rawVersion === "*" || rawVersion === "" ? "any" : rawVersion === "-" ? "unspecified" : rawVersion;
  return { vendor, product, version };
}

function addProduct(
  products: Map<string, CveProduct>,
  vendor: string,
  product: string,
  version: string,
): void {
  const key = `${vendor.toLowerCase()}\u0000${product.toLowerCase()}`;
  const existing = products.get(key);
  if (!existing) {
    products.set(key, { vendor, product, versions: [version] });
    return;
  }
  if (!existing.versions.includes(version)) existing.versions.push(version);
}

function collectProducts(configurations: NvdConfiguration[] | undefined): CveProduct[] {
  const products = new Map<string, CveProduct>();

  const visit = (node: NvdNode): void => {
    for (const match of node.cpeMatch ?? []) {
      if (!match.criteria) continue;
      const parsed = parseCpe(match.criteria);
      if (parsed) addProduct(products, parsed.vendor, parsed.product, parsed.version);
    }
    for (const child of node.children ?? []) visit(child);
  };

  for (const configuration of configurations ?? []) {
    for (const node of configuration.nodes ?? []) visit(node);
  }

  return [...products.values()]
    .map((item) => ({ ...item, versions: [...item.versions].sort() }))
    .sort((a, b) =>
      `${a.vendor}/${a.product}`.localeCompare(`${b.vendor}/${b.product}`),
    );
}

function pickDescription(descriptions: NvdDescription[] | undefined): string {
  if (!descriptions || descriptions.length === 0) return "Descrição não disponível nos metadados.";
  const english = descriptions.find((item) => item.lang === "en" && cleanText(item.value));
  return cleanText((english ?? descriptions[0]).value) || "Descrição não disponível nos metadados.";
}

function extractCwes(weaknesses: NvdWeakness[] | undefined): string[] {
  const found = new Set<string>();
  for (const weakness of weaknesses ?? []) {
    for (const description of weakness.description ?? []) {
      const value = cleanText(description.value).toUpperCase();
      if (/^CWE-\d+$/.test(value)) found.add(value);
    }
  }
  return [...found].sort();
}

function extractCvss(
  metrics: Record<string, NvdMetric[] | undefined> | undefined,
): CvssInfo | undefined {
  if (!metrics) return undefined;
  const metric =
    metrics.cvssMetricV31?.[0] ??
    metrics.cvssMetricV30?.[0] ??
    metrics.cvssMetricV2?.[0];
  const data = metric?.cvssData;
  if (!data || typeof data.baseScore !== "number") return undefined;
  const severity = cleanText(data.baseSeverity ?? metric?.baseSeverity) || severityFromScore(data.baseScore);
  const fallbackVersion = metrics.cvssMetricV2 ? "2.0" : "3.1";
  return {
    version: cleanText(data.version) || fallbackVersion,
    score: data.baseScore,
    severity: severity.toUpperCase(),
    vector: cleanText(data.vectorString),
  };
}

function extractReferences(references: NvdReference[] | undefined): CveReference[] {
  const byUrl = new Map<string, CveReference>();
  for (const reference of references ?? []) {
    const url = cleanText(reference.url);
    if (!url) continue;
    const tags = (reference.tags ?? []).map((tag) => cleanText(tag)).filter(Boolean);
    const existing = byUrl.get(url);
    if (existing) {
      existing.tags = [...new Set([...existing.tags, ...tags])];
    } else {
      byUrl.set(url, { url, tags });
    }
  }
  return [...byUrl.values()];
}

/**
 * Normaliza um item bruto do NVD 2.0 (formato `{cve: {...}}`) para
 * `CveRecord`. Também aceita o objeto `cve` diretamente.
 */
export function normalizeCve(raw: unknown): CveRecord {
  const item = (raw ?? {}) as NvdItem & NvdCve;
  const cve = item.cve ?? item;
  const id = cleanText(cve.id).toUpperCase();
  if (!id) throw new Error("Registro NVD inválido: campo cve.id ausente.");

  return {
    id,
    source: cleanText(cve.sourceIdentifier) || "nvd@nist.gov",
    published: cleanText(cve.published),
    modified: cleanText(cve.lastModified) || cleanText(cve.published),
    description: pickDescription(cve.descriptions),
    cvss: extractCvss(cve.metrics),
    cwes: extractCwes(cve.weaknesses),
    products: collectProducts(cve.configurations),
    references: extractReferences(cve.references),
    weaknesses: extractCwes(cve.weaknesses),
  };
}

function dateValue(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function mergeProducts(a: CveProduct[], b: CveProduct[]): CveProduct[] {
  const map = new Map<string, CveProduct>();
  for (const product of [...a, ...b]) {
    const key = `${product.vendor.toLowerCase()}\u0000${product.product.toLowerCase()}`;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, { ...product, versions: [...product.versions] });
      continue;
    }
    existing.versions = [...new Set([...existing.versions, ...product.versions])].sort();
  }
  return [...map.values()].sort((x, y) =>
    `${x.vendor}/${x.product}`.localeCompare(`${y.vendor}/${y.product}`),
  );
}

function mergeReferences(a: CveReference[], b: CveReference[]): CveReference[] {
  const map = new Map<string, CveReference>();
  for (const reference of [...a, ...b]) {
    const existing = map.get(reference.url);
    if (!existing) {
      map.set(reference.url, { ...reference, tags: [...reference.tags] });
    } else {
      existing.tags = [...new Set([...existing.tags, ...reference.tags])];
    }
  }
  return [...map.values()];
}

function mergePair(a: CveRecord, b: CveRecord): CveRecord {
  const newer = dateValue(b.modified || b.published) >= dateValue(a.modified || a.published) ? b : a;
  const older = newer === b ? a : b;
  return {
    ...newer,
    cwes: [...new Set([...older.cwes, ...newer.cwes])].sort(),
    weaknesses: [...new Set([...older.weaknesses, ...newer.weaknesses])].sort(),
    products: mergeProducts(older.products, newer.products),
    references: mergeReferences(older.references, newer.references),
    cvss: newer.cvss ?? older.cvss,
    mitigation: newer.mitigation ?? older.mitigation,
  };
}

/** Deduplica CVEs por id, preservando a versão mais recente. */
export function mergeCves(records: CveRecord[]): CveRecord[] {
  const byId = new Map<string, CveRecord>();
  for (const record of records) {
    const id = cleanText(record.id).toUpperCase();
    if (!id) continue;
    const normalized: CveRecord = { ...record, id };
    const existing = byId.get(id);
    byId.set(id, existing ? mergePair(existing, normalized) : normalized);
  }
  return [...byId.values()];
}

function looksLikeCveRecord(value: unknown): value is CveRecord {
  if (value === null || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.id === "string" && Array.isArray(obj.cwes) && Array.isArray(obj.products);
}

function recordsFromUnknown(value: unknown): CveRecord[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (looksLikeCveRecord(item)) return [item];
      try {
        return [normalizeCve(item)];
      } catch {
        return [];
      }
    });
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (Array.isArray(obj.records)) return recordsFromUnknown(obj.records);
    if (Array.isArray(obj.items)) return recordsFromUnknown(obj.items);
    if (Array.isArray(obj.vulnerabilities)) return recordsFromUnknown(obj.vulnerabilities);
  }
  return [];
}

/** Caminho do cache mais recente (ou `null` se ainda não houver cache). */
export function latestCacheFile(cacheDir = DEFAULT_CACHE_DIR): string | null {
  try {
    const files = fs
      .readdirSync(cacheDir)
      .filter((name) => /^nvd-.*\.json$/.test(name))
      .sort();
    return files.length > 0 ? path.join(cacheDir, files[files.length - 1]) : null;
  } catch {
    return null;
  }
}

/**
 * Carrega um cache NVD normalizado. Aceita um arquivo ou diretório; sem
 * argumento usa o arquivo mais recente de `DEFAULT_CACHE_DIR`.
 */
export function loadCache(target: string = DEFAULT_CACHE_DIR): CveRecord[] {
  let file: string | null = null;
  try {
    const stat = fs.statSync(target);
    file = stat.isDirectory() ? latestCacheFile(target) : target;
  } catch {
    return [];
  }
  if (!file) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return mergeCves(recordsFromUnknown(parsed));
  } catch {
    return [];
  }
}

function writeCache(file: string, value: NvdCacheFile): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

async function requestNvd(url: URL, apiKey?: string): Promise<NvdResponse> {
  const maxAttempts = 5;
  let lastError: unknown = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, {
        headers: apiKey ? { apiKey } : {},
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts - 1) {
        await sleep(2000 * 2 ** attempt);
        continue;
      }
      break;
    }

    if (response.ok) return (await response.json()) as NvdResponse;

    if ([403, 429, 503].includes(response.status) && attempt < maxAttempts - 1) {
      const retryAfter = Number(response.headers.get("retry-after"));
      const wait =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : 2000 * 2 ** attempt;
      await sleep(wait);
      continue;
    }

    throw new Error(`NVD respondeu ${response.status} ${response.statusText}`.trim());
  }

  throw lastError instanceof Error ? lastError : new Error("Falha ao consultar o NVD.");
}

/**
 * Coleta CVEs publicados na janela informada, paginando e persistindo o
 * cache parcial a cada página. Retorna os registros normalizados.
 */
export async function fetchCves(options: FetchCvesOptions): Promise<CveRecord[]> {
  const days = Math.max(1, Math.floor(options.days));
  const max = Math.max(0, Math.floor(options.max));
  if (max === 0) return [];

  const cacheDir = options.cacheDir ?? DEFAULT_CACHE_DIR;
  fs.mkdirSync(cacheDir, { recursive: true });
  const cacheFile = path.join(cacheDir, `nvd-${Date.now()}.json`);

  const end = new Date();
  const start = new Date(end.getTime() - days * 86_400_000);
  const rate = options.apiKey ? RATE_LIMIT_MS.withKey : RATE_LIMIT_MS.withoutKey;
  const perPage = Math.min(
    2000,
    Math.max(1, options.resultsPerPage ?? Math.min(max, 2000)),
  );

  let index = Math.max(0, Math.floor(options.startIndex ?? 0));
  let totalResults = 0;
  const collected: CveRecord[] = [];
  let firstRequest = true;

  while (collected.length < max) {
    if (!firstRequest) await sleep(rate);
    firstRequest = false;

    const pageSize = Math.min(perPage, max - collected.length);
    const url = new URL(NVD_API_URL);
    url.searchParams.set("pubStartDate", start.toISOString());
    url.searchParams.set("pubEndDate", end.toISOString());
    url.searchParams.set("startIndex", String(index));
    url.searchParams.set("resultsPerPage", String(pageSize));

    const response = await requestNvd(url, options.apiKey);
    if (typeof response.totalResults === "number") totalResults = response.totalResults;

    const vulnerabilities = response.vulnerabilities ?? [];
    if (vulnerabilities.length === 0) break;

    for (const item of vulnerabilities) {
      try {
        collected.push(normalizeCve(item));
      } catch {
        // Registro malformado não interrompe a coleta.
      }
    }

    index += vulnerabilities.length;
    writeCache(cacheFile, {
      fetchedAt: new Date().toISOString(),
      source: NVD_API_URL,
      startIndex: index,
      totalResults,
      records: mergeCves(collected),
    });

    if (index >= totalResults) break;
  }

  return mergeCves(collected);
}
