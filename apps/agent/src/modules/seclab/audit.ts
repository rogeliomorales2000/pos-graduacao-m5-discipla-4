import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/**
 * Log de auditoria append-only com encadeamento de hashes.
 *
 * Cada registro guarda o hash do anterior. Alterar/remover uma linha quebra a
 * cadeia e pode ser detectado por verifyChain(). O arquivo nunca é reescrito
 * por este módulo: apenas novas linhas são anexadas.
 */

export interface AuditEntry {
  seq: number;
  ts: string;
  event: unknown;
  prevHash: string;
  hash: string;
}

export interface ChainVerification {
  valid: boolean;
  /** Sequência do primeiro registro inválido (1-based). */
  brokenAt?: number;
  /** Índice de linha (0-based) do primeiro registro inválido. */
  brokenIndex?: number;
  reason?: string;
  /** Quantidade de registros lidos quando a cadeia está válida. */
  entries: number;
}

export interface AppendAuditOptions {
  /** Timestamp fixo para testes/reimportação. Padrão: agora. */
  ts?: string;
}

export const GENESIS_HASH = "0".repeat(64);

/** sha256(seq + ts + JSON(event) + prevHash), conforme o formato do log. */
export function computeAuditHash(
  seq: number,
  ts: string,
  event: unknown,
  prevHash: string,
): string {
  const payload = JSON.stringify(event);
  if (payload === undefined) {
    throw new Error("Evento de auditoria não é serializável em JSON");
  }
  return crypto
    .createHash("sha256")
    .update(`${seq}${ts}${payload}${prevHash}`, "utf8")
    .digest("hex");
}

/** Alias curto para quem preferir chamar hash diretamente. */
export const auditHash = computeAuditHash;

function ensureParent(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function readLines(file: string): string[] {
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, "utf8");
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function readAudit(file: string): AuditEntry[] {
  const lines = readLines(file);
  return lines.map((line, index) => {
    try {
      return JSON.parse(line) as AuditEntry;
    } catch (error) {
      throw new Error(
        `Auditoria inválida em ${file}, linha ${index + 1}: ${(error as Error).message}`,
      );
    }
  });
}

export function appendAudit(
  file: string,
  event: unknown,
  options: AppendAuditOptions = {},
): AuditEntry {
  const existing = readAudit(file);
  const previous = existing[existing.length - 1];
  const seq = previous ? previous.seq + 1 : 1;
  const ts = options.ts ?? new Date().toISOString();
  const prevHash = previous?.hash ?? GENESIS_HASH;
  const entry: AuditEntry = {
    seq,
    ts,
    event,
    prevHash,
    hash: computeAuditHash(seq, ts, event, prevHash),
  };

  ensureParent(file);
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, "utf8");
  return entry;
}

/**
 * Verifica estrutura, sequência, encadeamento e hash de cada registro.
 * O arquivo ausente é considerado uma cadeia vazia válida.
 */
export function verifyChain(file: string): ChainVerification {
  const lines = readLines(file);
  const entries = lines.length;
  let expectedPrev = GENESIS_HASH;

  for (let index = 0; index < lines.length; index++) {
    let entry: AuditEntry;
    try {
      entry = JSON.parse(lines[index]) as AuditEntry;
    } catch (error) {
      return {
        valid: false,
        brokenAt: index + 1,
        brokenIndex: index,
        reason: `JSON inválido: ${(error as Error).message}`,
        entries,
      };
    }

    const brokenAt = Number.isInteger(entry.seq) ? entry.seq : index + 1;
    const fail = (reason: string): ChainVerification => ({
      valid: false,
      brokenAt,
      brokenIndex: index,
      reason,
      entries,
    });

    if (!Number.isInteger(entry.seq) || entry.seq !== index + 1) {
      return fail(`sequência inesperada: ${String(entry.seq)} (esperado ${index + 1})`);
    }
    if (typeof entry.ts !== "string" || Number.isNaN(Date.parse(entry.ts))) {
      return fail("timestamp inválido");
    }
    if (entry.prevHash !== expectedPrev) {
      return fail(`prevHash não corresponde ao registro anterior (seq ${entry.seq})`);
    }

    let recomputed: string;
    try {
      recomputed = computeAuditHash(entry.seq, entry.ts, entry.event, entry.prevHash);
    } catch (error) {
      return fail(`evento não verificável: ${(error as Error).message}`);
    }
    if (recomputed !== entry.hash) {
      return fail(`hash adulterado (seq ${entry.seq})`);
    }

    expectedPrev = entry.hash;
  }

  return { valid: true, entries };
}
