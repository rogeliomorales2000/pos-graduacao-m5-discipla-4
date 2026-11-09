/**
 * CVSS v3.1 — cálculo do score base conforme a especificação oficial.
 *
 * Referência de pesos: FIRST CVSS v3.1 Specification (seção 7.4).
 * Não há dependências externas e nenhuma métrica temporal/ambiental é
 * inventada: apenas AV, AC, PR, UI, S, C, I e A.
 */

export type AttackVector = "N" | "A" | "L" | "P";
export type AttackComplexity = "L" | "H";
export type PrivilegesRequired = "N" | "L" | "H";
export type UserInteraction = "N" | "R";
export type Scope = "U" | "C";
export type CiaImpact = "H" | "L" | "N";
export type Severity = "None" | "Low" | "Medium" | "High" | "Critical";

export interface Cvss31Metrics {
  AV: AttackVector;
  AC: AttackComplexity;
  PR: PrivilegesRequired;
  UI: UserInteraction;
  S: Scope;
  C: CiaImpact;
  I: CiaImpact;
  A: CiaImpact;
}

export interface Cvss31Details {
  score: number;
  severity: Severity;
  impact: number;
  exploitability: number;
  iss: number;
}

const AV: Record<AttackVector, number> = { N: 0.85, A: 0.62, L: 0.55, P: 0.2 };
const AC: Record<AttackComplexity, number> = { L: 0.77, H: 0.44 };
const UI: Record<UserInteraction, number> = { N: 0.85, R: 0.62 };
const CIA: Record<CiaImpact, number> = { H: 0.56, L: 0.22, N: 0 };
const PR_UNCHANGED: Record<PrivilegesRequired, number> = { N: 0.85, L: 0.62, H: 0.27 };
const PR_CHANGED: Record<PrivilegesRequired, number> = { N: 0.85, L: 0.68, H: 0.5 };

const METRIC_KEYS = ["AV", "AC", "PR", "UI", "S", "C", "I", "A"] as const;

/**
 * Arredondamento oficial do CVSS 3.1 (Roundup), imune a ruído de ponto
 * flutuante. Ex.: 4.02 -> 4.1; 4.0 -> 4.0; 9.800000001 -> 9.8.
 */
export function roundup(value: number): number {
  const intInput = Math.round(value * 100000);
  if (intInput % 10000 === 0) return intInput / 100000;
  return (Math.floor(intInput / 10000) + 1) / 10;
}

function valueOf(metric: string, map: Record<string, number>, raw: unknown): number {
  if (typeof raw !== "string" || !Object.prototype.hasOwnProperty.call(map, raw)) {
    throw new Error(`Métrica ${metric} inválida: ${String(raw)}`);
  }
  return map[raw];
}

export function severity(score: number): Severity {
  if (!Number.isFinite(score) || score < 0 || score > 10) {
    throw new Error(`Score CVSS inválido: ${score}`);
  }
  if (score === 0) return "None";
  if (score < 4) return "Low";
  if (score < 7) return "Medium";
  if (score < 9) return "High";
  return "Critical";
}

export function iss(metrics: Cvss31Metrics): number {
  return 1 - (1 - CIA[metrics.C]) * (1 - CIA[metrics.I]) * (1 - CIA[metrics.A]);
}

export function impact(metrics: Cvss31Metrics): number {
  const value = iss(metrics);
  return metrics.S === "U"
    ? 6.42 * value
    : 7.52 * (value - 0.029) - 3.25 * Math.pow(value - 0.02, 15);
}

export function exploitability(metrics: Cvss31Metrics): number {
  const pr = metrics.S === "U" ? PR_UNCHANGED[metrics.PR] : PR_CHANGED[metrics.PR];
  return 8.22 * AV[metrics.AV] * AC[metrics.AC] * pr * UI[metrics.UI];
}

function validateMetrics(metrics: Cvss31Metrics): void {
  if (!metrics || typeof metrics !== "object") {
    throw new Error("Métricas CVSS ausentes");
  }
  valueOf("AV", AV, metrics.AV);
  valueOf("AC", AC, metrics.AC);
  valueOf("PR", PR_UNCHANGED, metrics.PR);
  valueOf("UI", UI, metrics.UI);
  if (metrics.S !== "U" && metrics.S !== "C") throw new Error(`Métrica S inválida: ${String(metrics.S)}`);
  valueOf("C", CIA, metrics.C);
  valueOf("I", CIA, metrics.I);
  valueOf("A", CIA, metrics.A);
}

/** Score base CVSS 3.1 (0.0–10.0), com Roundup oficial. */
export function cvss31(metrics: Cvss31Metrics): number {
  return cvss31Details(metrics).score;
}

export function cvss31Details(metrics: Cvss31Metrics): Cvss31Details {
  validateMetrics(metrics);
  const impactScore = impact(metrics);
  const exploitabilityScore = exploitability(metrics);
  const issValue = iss(metrics);

  if (impactScore <= 0) {
    return {
      score: 0,
      severity: "None",
      impact: 0,
      exploitability: exploitabilityScore,
      iss: issValue,
    };
  }

  const raw =
    metrics.S === "U"
      ? Math.min(impactScore + exploitabilityScore, 10)
      : Math.min(1.08 * (impactScore + exploitabilityScore), 10);
  const score = roundup(raw);

  return {
    score,
    severity: severity(score),
    impact: impactScore,
    exploitability: exploitabilityScore,
    iss: issValue,
  };
}

/** Converte "CVSS:3.1/AV:N/..." nas métricas base. */
export function parseVector(vector: string): Cvss31Metrics {
  if (typeof vector !== "string" || vector.trim().length === 0) {
    throw new Error("Vetor CVSS vazio");
  }

  const parts = vector.trim().split("/");
  const prefix = parts.shift()?.toUpperCase();
  if (prefix !== "CVSS:3.1") {
    throw new Error(`Vetor não é CVSS 3.1: "${vector}"`);
  }

  const found: Partial<Record<(typeof METRIC_KEYS)[number], string>> = {};
  for (const part of parts) {
    const separator = part.indexOf(":");
    if (separator <= 0 || separator !== part.lastIndexOf(":")) {
      throw new Error(`Componente inválido no vetor: "${part}"`);
    }
    const key = part.slice(0, separator).toUpperCase() as (typeof METRIC_KEYS)[number];
    const value = part.slice(separator + 1).toUpperCase();
    if (!METRIC_KEYS.includes(key)) {
      throw new Error(`Métrica desconhecida no vetor: "${key}"`);
    }
    if (key in found) {
      throw new Error(`Métrica duplicada no vetor: "${key}"`);
    }
    found[key] = value;
  }

  for (const key of METRIC_KEYS) {
    if (!(key in found)) throw new Error(`Métrica ausente no vetor: ${key}`);
  }

  const metrics: Cvss31Metrics = {
    AV: found.AV as AttackVector,
    AC: found.AC as AttackComplexity,
    PR: found.PR as PrivilegesRequired,
    UI: found.UI as UserInteraction,
    S: found.S as Scope,
    C: found.C as CiaImpact,
    I: found.I as CiaImpact,
    A: found.A as CiaImpact,
  };
  validateMetrics(metrics);
  return metrics;
}

/** Score diretamente a partir do vetor. */
export function scoreVector(vector: string): number {
  return cvss31(parseVector(vector));
}

export function formatVector(metrics: Cvss31Metrics): string {
  validateMetrics(metrics);
  return `CVSS:3.1/AV:${metrics.AV}/AC:${metrics.AC}/PR:${metrics.PR}/UI:${metrics.UI}/S:${metrics.S}/C:${metrics.C}/I:${metrics.I}/A:${metrics.A}`;
}

/**
 * Apenas informativo: este módulo não calcula CVSS 4.0.
 * A v4.0 usa métricas diferentes (ex.: AT, VC/VI/VA, SC/SI/SA) e outra
 * fórmula de agregação; não converta scores entre versões.
 */
export function cvss4Hint(): string {
  return (
    "CVSS 4.0 é um padrão distinto do 3.1: usa métricas de sistema vulnerável " +
    "e sistema subsequente (VC/VI/VA, SC/SI/SA) e regras próprias de agregação. " +
    "Este módulo calcula somente o score base CVSS 3.1; não converta nem " +
    "compare scores entre versões sem a calculadora oficial."
  );
}
