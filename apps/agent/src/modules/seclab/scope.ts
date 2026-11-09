import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/**
 * Escopo assinado do laboratório de segurança.
 *
 * Toda ação de recon/lab só pode acontecer contra alvos presentes em uma
 * autorização válida. O arquivo é intencionalmente simples (JSON) para poder
 * ser versionado, revisado e assinado fora da ferramenta.
 */

export type ScopeTargetKind = "host" | "cidr" | "url" | "device" | "repo";

export interface ScopeTarget {
  kind: ScopeTargetKind;
  value: string;
  note?: string;
}

export interface Authorization {
  id: string;
  authorizedBy: string;
  /** Referência ao documento/contrato/ticket que autoriza o teste. */
  authorizationRef: string;
  /** Datas em ISO-8601 (ex.: 2026-11-03T12:00:00.000Z). */
  startsAt: string;
  expiresAt: string;
  targets: ScopeTarget[];
  notes?: string;
}

export interface CreateAuthorizationInput {
  authorizedBy: string;
  authorizationRef: string;
  targets: Array<ScopeTarget | string>;
  notes?: string;
  startsAt?: string;
  expiresAt?: string;
  /** Usado quando expiresAt não é informado. Padrão: 1 dia. */
  days?: number;
  /** Permitir id determinístico em testes/importações. */
  id?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

const TARGET_KINDS: readonly ScopeTargetKind[] = ["host", "cidr", "url", "device", "repo"];
const DAY_MS = 24 * 60 * 60 * 1000;

function nowDate(now: Date | string | number = new Date()): Date {
  return now instanceof Date ? now : new Date(now);
}

function parseDateMs(value: string): number | null {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\/+$/, "");
}

function ipv4ToInt(value: string): number | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n < 0 || n > 255) return null;
    out = out * 256 + n;
  }
  return out >>> 0;
}

function parseCidr(value: string): { base: number; bits: number } | null {
  const [addr, bitsRaw, extra] = value.split("/");
  if (extra !== undefined || !addr || bitsRaw === undefined) return null;
  if (!/^\d{1,2}$/.test(bitsRaw)) return null;
  const bits = Number(bitsRaw);
  if (bits < 0 || bits > 32) return null;
  const base = ipv4ToInt(addr);
  if (base === null) return null;
  return { base, bits };
}

function cidrMask(bits: number): number {
  if (bits === 0) return 0;
  return (0xffffffff << (32 - bits)) >>> 0;
}

function looksLikeCidr(value: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}$/.test(value.trim());
}

/** CIDR externo contém um IP ou outro CIDR (IPv4). */
function cidrContainsCidr(outerValue: string, innerValue: string): boolean {
  const outer = parseCidr(outerValue);
  if (!outer) return false;

  if (innerValue.includes("/")) {
    const inner = parseCidr(innerValue);
    if (!inner || inner.bits < outer.bits) return false;
    const mask = cidrMask(outer.bits);
    const innerMask = cidrMask(inner.bits);
    const innerStart = (inner.base & innerMask) >>> 0;
    const innerEnd = (innerStart | (~innerMask >>> 0)) >>> 0;
    const outerStart = (outer.base & mask) >>> 0;
    const outerEnd = (outerStart | (~mask >>> 0)) >>> 0;
    return innerStart >= outerStart && innerEnd <= outerEnd;
  }

  const ip = ipv4ToInt(innerValue);
  if (ip === null) return false;
  return ((ip & cidrMask(outer.bits)) >>> 0) === ((outer.base & cidrMask(outer.bits)) >>> 0);
}

function tryUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/** Extrai o hostname de uma URL/host:porta, sem resolver DNS. */
function candidateHostname(value: string): string {
  const trimmed = value.trim();
  const url = tryUrl(trimmed);
  if (url) return url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const withoutPath = trimmed.split("/")[0] ?? trimmed;
  const withoutUser = withoutPath.includes("@") ? withoutPath.slice(withoutPath.lastIndexOf("@") + 1) : withoutPath;
  if (withoutUser.startsWith("[")) {
    const end = withoutUser.indexOf("]");
    return (end >= 0 ? withoutUser.slice(0, end + 1) : withoutUser).toLowerCase();
  }
  return (withoutUser.split(":")[0] ?? withoutUser).toLowerCase();
}

function candidateHostPort(value: string): string {
  const trimmed = value.trim();
  const url = tryUrl(trimmed);
  if (url) return url.host.toLowerCase();
  return trimmed.replace(/^[a-z]+:\/\//i, "").split("/")[0]?.toLowerCase() ?? "";
}

function urlMatches(scopeValue: string, candidate: string): boolean {
  const scopeUrl = tryUrl(scopeValue);
  if (!scopeUrl) return hostMatches(scopeValue, candidate);
  const targetUrl = tryUrl(candidate);
  if (!targetUrl) {
    // Aceita também "example.com/path" quando o escopo é uma URL.
    const host = candidateHostname(candidate);
    if (host !== scopeUrl.hostname.toLowerCase()) return false;
    return true;
  }
  if (targetUrl.protocol !== scopeUrl.protocol) return false;
  if (targetUrl.hostname.toLowerCase() !== scopeUrl.hostname.toLowerCase()) return false;

  const scopePort = scopeUrl.port || (scopeUrl.protocol === "https:" ? "443" : "80");
  const targetPort = targetUrl.port || (targetUrl.protocol === "https:" ? "443" : "80");
  if (scopePort !== targetPort) return false;

  const scopePath = scopeUrl.pathname.replace(/\/+$/, "") || "/";
  const targetPath = targetUrl.pathname.replace(/\/+$/, "") || "/";
  if (scopePath === "/") return true;
  return targetPath === scopePath || targetPath.startsWith(`${scopePath}/`);
}

function hostMatches(scopeValue: string, candidate: string): boolean {
  const scope = normalize(scopeValue);
  const rawCandidate = candidate.trim().toLowerCase();
  if (!scope) return false;
  if (rawCandidate === scope) return true;

  const host = candidateHostname(candidate);
  const hostPort = candidateHostPort(candidate);

  if (scope.startsWith("*.")) {
    const suffix = scope.slice(1);
    return host.endsWith(suffix) && host.length > suffix.length;
  }

  const scopeNoScheme = normalize(scopeValue.replace(/^[a-z]+:\/\//i, ""));
  if (host === scopeNoScheme || hostPort === scopeNoScheme) return true;

  const scopeHost = candidateHostname(scopeValue);
  if (host === scopeHost) return true;
  return hostPort === scopeNoScheme;
}

function repoMatches(scopeValue: string, candidate: string): boolean {
  const scope = normalize(scopeValue).replace(/\.git$/, "");
  const target = normalize(candidate).replace(/\.git$/, "");
  return target === scope || target.startsWith(`${scope}/`);
}

function deviceMatches(scopeValue: string, candidate: string): boolean {
  const scope = normalize(scopeValue).replace(/^device:/, "");
  const target = normalize(candidate).replace(/^device:/, "");
  return scope === target;
}

/**
 * Procura o alvo autorizado que cobre `target`.
 * Retorna null quando não há cobertura (não lança).
 */
export function findScopeMatch(
  auth: Authorization,
  target: ScopeTarget | string,
): ScopeTarget | null {
  if (!auth || !Array.isArray(auth.targets)) return null;
  const value = typeof target === "string" ? target : target?.value;
  if (!isNonEmptyString(value)) return null;

  const candidate = value.trim();
  const normalizedCandidate = normalize(candidate);

  for (const entry of auth.targets) {
    if (!entry || !TARGET_KINDS.includes(entry.kind) || !isNonEmptyString(entry.value)) continue;
    const scopeValue = entry.value.trim();
    const normalizedScope = normalize(scopeValue);

    // Igualdade literal sempre vale, independentemente do tipo.
    if (normalizedCandidate === normalizedScope) return entry;

    switch (entry.kind) {
      case "host":
        if (hostMatches(scopeValue, candidate)) return entry;
        break;
      case "cidr":
        if (looksLikeCidr(candidate)) {
          // Escanear uma sub-rede só é permitido se ela couber inteira no escopo.
          if (cidrContainsCidr(scopeValue, candidate)) return entry;
        } else if (cidrContainsCidr(scopeValue, candidateHostname(candidate))) {
          return entry;
        }
        break;
      case "url":
        if (urlMatches(scopeValue, candidate)) return entry;
        break;
      case "device":
        if (deviceMatches(scopeValue, candidate)) return entry;
        break;
      case "repo":
        if (repoMatches(scopeValue, candidate)) return entry;
        break;
    }
  }
  return null;
}

/** Aceita "host:127.0.0.1", "cidr:10.0.0.0/24", "url:https://...". */
export function parseScopeTarget(spec: string): ScopeTarget {
  const trimmed = spec.trim();
  const index = trimmed.indexOf(":");
  if (index <= 0) {
    throw new Error(`Alvo inválido: "${spec}" (use kind:valor, ex.: host:127.0.0.1)`);
  }
  const kind = trimmed.slice(0, index).toLowerCase() as ScopeTargetKind;
  const value = trimmed.slice(index + 1).trim();
  if (!TARGET_KINDS.includes(kind)) {
    throw new Error(`Tipo de alvo inválido: "${kind}" (use ${TARGET_KINDS.join(", ")})`);
  }
  if (!value) throw new Error(`Valor vazio para o alvo "${spec}"`);
  return { kind, value };
}

export function createAuthorization(input: CreateAuthorizationInput): Authorization {
  if (!input || typeof input !== "object") {
    throw new Error("createAuthorization: entrada obrigatória");
  }
  const startsAt = input.startsAt ? new Date(input.startsAt) : new Date();
  if (Number.isNaN(startsAt.getTime())) {
    throw new Error(`startsAt inválido: ${input.startsAt}`);
  }

  const days = input.days ?? 1;
  if (!Number.isFinite(days) || days <= 0) {
    throw new Error(`days deve ser um número positivo (recebido: ${input.days})`);
  }

  let expiresAt: Date;
  if (input.expiresAt) {
    expiresAt = new Date(input.expiresAt);
    if (Number.isNaN(expiresAt.getTime())) {
      throw new Error(`expiresAt inválido: ${input.expiresAt}`);
    }
  } else {
    expiresAt = new Date(startsAt.getTime() + days * DAY_MS);
  }

  const targets = (Array.isArray(input.targets) ? input.targets : []).map((target) =>
    typeof target === "string" ? parseScopeTarget(target) : { ...target },
  );

  const auth: Authorization = {
    id: input.id?.trim() || `auth_${crypto.randomUUID()}`,
    authorizedBy: input.authorizedBy,
    authorizationRef: input.authorizationRef,
    startsAt: startsAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    targets,
    notes: input.notes ?? "",
  };

  const validation = validateAuthorization(auth);
  if (!validation.valid) {
    throw new Error(`Autorização inválida:\n- ${validation.errors.join("\n- ")}`);
  }
  return auth;
}

export function validateAuthorization(auth: Authorization): ValidationResult {
  const errors: string[] = [];
  if (!auth || typeof auth !== "object") {
    return { valid: false, errors: ["autorização ausente"] };
  }

  if (!isNonEmptyString(auth.id)) errors.push("id é obrigatório");
  if (!isNonEmptyString(auth.authorizedBy)) errors.push("authorizedBy é obrigatório");
  if (!isNonEmptyString(auth.authorizationRef)) errors.push("authorizationRef é obrigatório");
  if (!isNonEmptyString(auth.startsAt)) errors.push("startsAt é obrigatório");
  if (!isNonEmptyString(auth.expiresAt)) errors.push("expiresAt é obrigatório");

  const start = isNonEmptyString(auth.startsAt) ? parseDateMs(auth.startsAt) : null;
  const end = isNonEmptyString(auth.expiresAt) ? parseDateMs(auth.expiresAt) : null;
  if (isNonEmptyString(auth.startsAt) && start === null) errors.push("startsAt não é uma data válida");
  if (isNonEmptyString(auth.expiresAt) && end === null) errors.push("expiresAt não é uma data válida");
  if (start !== null && end !== null && end <= start) {
    errors.push("expiresAt deve ser posterior a startsAt");
  }

  if (!Array.isArray(auth.targets) || auth.targets.length === 0) {
    errors.push("pelo menos um alvo é obrigatório");
  } else {
    auth.targets.forEach((target, index) => {
      if (!target || typeof target !== "object") {
        errors.push(`targets[${index}] inválido`);
        return;
      }
      if (!TARGET_KINDS.includes(target.kind)) {
        errors.push(`targets[${index}].kind inválido (${String(target.kind)})`);
      }
      if (!isNonEmptyString(target.value)) {
        errors.push(`targets[${index}].value é obrigatório`);
      }
    });
  }

  return { valid: errors.length === 0, errors };
}

export function loadAuthorization(file: string): Authorization {
  const raw = fs.readFileSync(file, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Falha ao ler autorização ${file}: ${(error as Error).message}`);
  }

  // Aceita tanto o objeto direto quanto { "authorization": {...} }.
  const candidate =
    parsed && typeof parsed === "object" && "authorization" in parsed
      ? (parsed as { authorization: unknown }).authorization
      : parsed;

  const auth = candidate as Authorization;
  const validation = validateAuthorization(auth);
  if (!validation.valid) {
    throw new Error(`Autorização inválida em ${file}:\n- ${validation.errors.join("\n- ")}`);
  }
  return {
    ...auth,
    notes: auth.notes ?? "",
    targets: auth.targets.map((target) => ({ ...target })),
  };
}

export function saveAuthorization(file: string, auth: Authorization): void {
  const validation = validateAuthorization(auth);
  if (!validation.valid) {
    throw new Error(`Autorização inválida:\n- ${validation.errors.join("\n- ")}`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(auth, null, 2)}\n`, "utf8");
}

export function isExpired(auth: Authorization, now: Date | string | number = new Date()): boolean {
  if (!auth || !isNonEmptyString(auth.expiresAt)) return true;
  const end = parseDateMs(auth.expiresAt);
  if (end === null) return true;
  const current = nowDate(now);
  if (Number.isNaN(current.getTime())) return true;
  return current.getTime() >= end;
}

export function isActive(auth: Authorization, now: Date | string | number = new Date()): boolean {
  if (!auth || !isNonEmptyString(auth.startsAt)) return false;
  const start = parseDateMs(auth.startsAt);
  if (start === null) return false;
  const current = nowDate(now);
  if (Number.isNaN(current.getTime())) return false;
  return current.getTime() >= start && !isExpired(auth, current);
}

/**
 * Garante que o alvo está coberto e que a autorização está vigente.
 * Lança erro em qualquer outro caso e retorna o alvo autorizado que casou.
 */
export function assertInScope(auth: Authorization, target: ScopeTarget | string): ScopeTarget {
  if (!auth || !Array.isArray(auth.targets)) {
    throw new Error("Autorização ausente ou sem lista de alvos");
  }
  if (!isNonEmptyString(auth.startsAt) || !isNonEmptyString(auth.expiresAt)) {
    throw new Error("Autorização sem janela de validade (startsAt/expiresAt)");
  }

  const start = parseDateMs(auth.startsAt);
  const end = parseDateMs(auth.expiresAt);
  if (start === null || end === null) {
    throw new Error("Janela de validade da autorização é inválida");
  }
  if (end <= start) {
    throw new Error("Janela de validade da autorização é inconsistente");
  }

  const current = Date.now();
  if (current < start) {
    throw new Error(`Autorização ainda não está vigente (início: ${auth.startsAt})`);
  }
  if (current >= end) {
    throw new Error(`Autorização expirada em ${auth.expiresAt}`);
  }

  const value = typeof target === "string" ? target : target?.value;
  if (!isNonEmptyString(value)) throw new Error("Alvo vazio");

  const match = findScopeMatch(auth, value);
  if (!match) {
    throw new Error(`Alvo fora do escopo autorizado: ${value}`);
  }
  return match;
}

/** Distância entre o alvo e um escopo CIDR, útil apenas para mensagens. */
export function cidrContains(cidr: string, ip: string): boolean {
  return cidrContainsCidr(cidr, ip);
}
