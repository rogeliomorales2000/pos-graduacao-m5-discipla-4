import fs from "node:fs";
import path from "node:path";
import { AgentConfig, Autonomy } from "./types";
import { readJson } from "./util";

export const CONFIG_CANDIDATES = ["m5.agent.json", ".m5/agent.json", "agent.config.json"];

export function defaultConfig(workspace = process.cwd()): AgentConfig {
  return {
    workspace: path.resolve(workspace),
    // O usuário pediu autonomia total; o ledger de escopo/auditoria continua ativo.
    autonomy: "full",
    model: {
      kind: "local",
      path: path.join(path.resolve(workspace), "models", "m5coder.bin"),
      maxTokens: 512,
      temperature: 0.7,
      topP: 0.95,
      name: "m5coder-0.1",
    },
    policy: {
      scopeFile: path.join(path.resolve(workspace), ".m5", "scope.json"),
      auditFile: path.join(path.resolve(workspace), ".m5", "audit.jsonl"),
      allowNetwork: true,
      denyPatterns: [
        "rm -rf /",
        "mkfs",
        "format-volume",
        "Remove-Item -Recurse -Force C:\\",
        ":(){:|:&};:",
        "shutdown /s",
        "Stop-Computer",
      ],
    },
    limits: {
      maxSteps: 40,
      maxToolCalls: 120,
      maxWallClockMs: 30 * 60_000,
      maxToolOutputChars: 24_000,
      maxTaskAttempts: 3,
    },
    verify: {
      enabled: true,
      commands: [],
      timeoutMs: 180_000,
    },
    index: {
      enabled: true,
      storePath: path.join(path.resolve(workspace), ".m5", "code-index.json"),
      maxFiles: 6_000,
      maxFileBytes: 400_000,
    },
  };
}

function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return base;
  const out = { ...base } as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    const current = (base as Record<string, unknown>)[key];
    out[key] = current && typeof current === "object" && !Array.isArray(current)
      ? deepMerge(current, value)
      : value;
  }
  return out as T;
}

export interface LoadedConfig {
  config: AgentConfig;
  source: string | null;
  warnings: string[];
}

export function loadConfig(workspace = process.cwd(), overrides: Partial<AgentConfig> = {}): LoadedConfig {
  const ws = path.resolve(workspace);
  const base = defaultConfig(ws);
  const warnings: string[] = [];
  let source: string | null = null;
  let fileConfig: unknown = {};

  for (const candidate of CONFIG_CANDIDATES) {
    const file = path.join(ws, candidate);
    if (fs.existsSync(file)) {
      try {
        fileConfig = readJson(file, {});
        source = file;
      } catch (err) {
        warnings.push(`Falha ao ler ${file}: ${(err as Error).message}`);
      }
      break;
    }
  }

  let config = deepMerge(base, fileConfig);
  config = deepMerge(config, overrides);
  config.workspace = path.resolve(config.workspace || ws);

  if (process.env.M5_AUTONOMY) {
    const value = process.env.M5_AUTONOMY as Autonomy;
    if (["full", "confirm", "plan"].includes(value)) config.autonomy = value;
    else warnings.push(`M5_AUTONOMY inválido: ${process.env.M5_AUTONOMY}`);
  }
  if (process.env.M5_MODEL_BASE_URL) {
    config.model.kind = "http";
    config.model.baseUrl = process.env.M5_MODEL_BASE_URL;
    config.model.name = process.env.M5_MODEL_NAME || config.model.name;
  }
  if (process.env.M5_MODEL_PATH) config.model.path = process.env.M5_MODEL_PATH;
  const attemptsRaw = process.env.M5_TASK_ATTEMPTS ?? process.env.M5_TASK_RETRIES;
  if (attemptsRaw) {
    const attempts = Number(attemptsRaw);
    if (Number.isFinite(attempts) && attempts >= 1) {
      config.limits.maxTaskAttempts = Math.floor(attempts);
    } else {
      warnings.push(`M5_TASK_ATTEMPTS inválido: ${attemptsRaw}`);
    }
  }

  // Caminhos relativos no arquivo são resolvidos a partir do workspace.
  for (const key of ["scopeFile", "auditFile"] as const) {
    if (!path.isAbsolute(config.policy[key])) {
      config.policy[key] = path.join(config.workspace, config.policy[key]);
    }
  }
  if (config.model.path && !path.isAbsolute(config.model.path)) {
    config.model.path = path.join(config.workspace, config.model.path);
  }
  if (!path.isAbsolute(config.index.storePath)) {
    config.index.storePath = path.join(config.workspace, config.index.storePath);
  }

  return { config, source, warnings };
}

export function serializeConfig(config: AgentConfig): string {
  const { workspace, ...rest } = config;
  return JSON.stringify({ workspace: path.relative(process.cwd(), workspace) || ".", ...rest }, null, 2);
}
