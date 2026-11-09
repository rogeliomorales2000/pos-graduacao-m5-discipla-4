/**
 * Contratos do pipeline de conhecimento de segurança.
 *
 * Regra do módulo: apenas metadados públicos (NVD/CWE/CVSS) e índice do
 * ExploitDB. Nenhum corpo de exploit/PoC é baixado, armazenado ou gerado.
 */

/** Informação CVSS normalizada (v3.1, v3.0 ou v2). */
export interface CvssInfo {
  version: string;
  score: number;
  severity: string;
  vector: string;
}

/** Produto/versão extraído de um CPE 2.3. */
export interface CveProduct {
  vendor: string;
  product: string;
  versions: string[];
}

/** Referência pública associada ao CVE. */
export interface CveReference {
  url: string;
  tags: string[];
}

/** Registro de CVE normalizado a partir do feed NVD 2.0 (ou do seed offline). */
export interface CveRecord {
  id: string;
  source: string;
  published: string;
  modified: string;
  description: string;
  cvss?: CvssInfo;
  cwes: string[];
  products: CveProduct[];
  references: CveReference[];
  weaknesses: string[];
  /** Mitigação defensiva curada (opcional; usada pelo seed). */
  mitigation?: string;
}

/** Registro de metadados do índice ExploitDB (sem o corpo do exploit). */
export interface EdbRecord {
  id: string;
  /** Caminho/arquivo de catálogo informado pelo CSV. Nunca é baixado. */
  file?: string;
  description: string;
  datePublished: string;
  author: string;
  type: string;
  platform: string;
  cveCodes: string[];
  url: string;
}

/** Amostra de instrução no formato usado pelo dataset do agente. */
export interface KnowledgeSample {
  instruction: string;
  input: string;
  output: string;
  meta: Record<string, unknown>;
}
