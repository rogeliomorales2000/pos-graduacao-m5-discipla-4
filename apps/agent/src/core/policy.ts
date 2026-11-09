import fs from "node:fs";
import path from "node:path";
import { AgentConfig } from "./types";
import { appendJsonl, ensureDir, readJson } from "./util";

export interface ScopeEntry {
  target: string;
  kind: "host" | "cidr" | "url" | "device" | "repo";
  note?: string;
  expires?: string;
}

export interface ScopeLedger {
  authorizedBy?: string;
  authorizationRef?: string;
  updatedAt?: string;
  targets: ScopeEntry[];
}

export type Classification = "safe" | "destructive" | "network" | "privileged" | "denied";

export interface PolicyDecision {
  classification: Classification;
  reasons: string[];
  /** Escopo aplicável quando a ação é de rede/lab. */
  scope?: ScopeEntry | null;
}

const NETWORK_HINTS = [
  "curl", "wget", "invoke-webrequest", "invoke-restmethod", "nc ", "ncat", "netcat",
  "nmap", "masscan", "ssh ", "scp ", "socat", "telnet", "ping ", "tracert", "tcpdump",
  "test-netconnection", "ftp ", "dig ", "nslookup",
];

const PRIVILEGED_HINTS = [
  "sudo", "runas", "start-process -verb runas", "reg add", "reg delete", "set-executionpolicy",
  "bcdedit", "diskpart", "sc.exe", "net user", "net localgroup", "takeown", "icacls",
  "adb root", "adb shell su", "fastboot oem", "fastboot flashing", "knox",
];

const DESTRUCTIVE_HINTS = [
  "rm -rf", "rm -r", "del /f", "del /s", "remove-item -recurse", "rd /s", "rmdir /s",
  "format ", "mkfs", "dd if=", "shred ", "truncate -s 0", "git reset --hard",
  "git clean -fdx", "drop database", "drop table", "truncate table",
  "shutdown", "reboot", "stop-computer", "restart-computer",
];

function norm(cmd: string): string {
  return cmd.toLowerCase().replace(/\s+/g, " ");
}

export class Policy {
  readonly config: AgentConfig;
  private scope: ScopeLedger;

  constructor(config: AgentConfig) {
    this.config = config;
    this.scope = this.loadScope();
  }

  get scopePath(): string {
    return this.config.policy.scopeFile;
  }

  reloadScope(): ScopeLedger {
    this.scope = this.loadScope();
    return this.scope;
  }

  private loadScope(): ScopeLedger {
    const ledger = readJson<ScopeLedger>(this.config.policy.scopeFile, { targets: [] });
    return { ...ledger, targets: ledger.targets ?? [] };
  }

  listScope(): ScopeLedger {
    return this.scope;
  }

  addScope(entry: ScopeEntry): ScopeLedger {
    this.reloadScope();
    const existing = this.scope.targets.find((t) => t.target === entry.target);
    if (existing) Object.assign(existing, entry);
    else this.scope.targets.push(entry);
    this.scope.updatedAt = new Date().toISOString();
    ensureDir(path.dirname(this.config.policy.scopeFile));
    fs.writeFileSync(this.config.policy.scopeFile, JSON.stringify(this.scope, null, 2));
    return this.scope;
  }

  /** Casa host/IP/URL/device contra o ledger. */
  matchScope(target: string): ScopeEntry | null {
    const t = target.trim().toLowerCase();
    for (const entry of this.scope.targets) {
      const value = entry.target.toLowerCase();
      if (value === t) return entry;
      if (entry.kind === "cidr" && cidrContains(value, t)) return entry;
      if (value.startsWith("*.") && t.endsWith(value.slice(1))) return entry;
      if (t.startsWith(value.endsWith("/") ? value : `${value}/`)) return entry;
    }
    return null;
  }

  classifyCommand(command: string): PolicyDecision {
    const c = norm(command);
    const reasons: string[] = [];

    for (const pattern of this.config.policy.denyPatterns) {
      if (pattern && c.includes(norm(pattern))) {
        return { classification: "denied", reasons: [`padrão proibido: ${pattern}`] };
      }
    }

    const destructive = DESTRUCTIVE_HINTS.find((h) => c.includes(h));
    if (destructive) reasons.push(`destrutivo: ${destructive}`);

    const network = NETWORK_HINTS.find((h) => c.includes(h));
    if (network) reasons.push(`rede: ${network.trim()}`);

    const privileged = PRIVILEGED_HINTS.find((h) => c.includes(h));
    if (privileged) reasons.push(`privilégio: ${privileged.trim()}`);

    // Precedência: bloqueado > destrutivo > privilégio > rede > seguro.
    let classification: Classification = "safe";
    if (destructive) classification = "destructive";
    else if (privileged) classification = "privileged";
    else if (network) classification = "network";

    let scope: ScopeEntry | null = null;
    if (network) {
      const target = extractTarget(command);
      scope = target ? this.matchScope(target) : null;
      if (target && !scope) reasons.push(`alvo fora do escopo: ${target}`);
    }

    return { classification, reasons, scope };
  }

  audit(event: Record<string, unknown>): void {
    appendJsonl(this.config.policy.auditFile, {
      ts: new Date().toISOString(),
      pid: process.pid,
      ...event,
    });
  }

  /** Kill switch: se .m5/STOP existir, o loop encerra antes do próximo passo. */
  stopped(): boolean {
    return fs.existsSync(path.join(this.config.workspace, ".m5", "STOP"));
  }

  /** Quanto de autonomia efetiva aplicar a uma decisão. */
  requiresApproval(decision: PolicyDecision): boolean {
    if (this.config.autonomy === "plan") return true;
    if (this.config.autonomy === "full") return false;
    return decision.classification !== "safe";
  }
}

function extractTarget(command: string): string | null {
  const url = command.match(/https?:\/\/[^\s"']+/i);
  if (url) return url[0];
  const ip = command.match(/\b(?:\d{1,3}\.){3}\d{1,3}(?:\/\d{1,2})?\b/);
  if (ip) return ip[0];
  const host = command.match(/\b(?:ssh|scp|ping|telnet|nmap|curl|wget)\s+(?:-\S+\s+)*([\w.-]+\.[a-z]{2,})/i);
  if (host) return host[1];
  return null;
}

export function cidrContains(cidr: string, ip: string): boolean {
  const [base, bitsRaw] = cidr.split("/");
  if (!base || !ip) return false;
  const bits = Number(bitsRaw ?? "32");
  const toInt = (value: string): number | null => {
    const parts = value.split(".");
    if (parts.length !== 4) return null;
    return parts.reduce((acc, part) => {
      const n = Number(part);
      if (!Number.isInteger(n) || n < 0 || n > 255) return NaN;
      return acc * 256 + n;
    }, 0);
  };
  const a = toInt(base);
  const b = toInt(ip);
  if (a === null || b === null || Number.isNaN(a) || Number.isNaN(b)) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (a & mask) >>> 0 === (b & mask) >>> 0;
}
