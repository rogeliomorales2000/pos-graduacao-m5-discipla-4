/**
 * Contratos compartilhados do M5 Agent.
 *
 * Tudo aqui é deliberadamente pequeno e estável: as tools, o loop, os
 * adapters de modelo e os módulos (redes, embarcados, seclab) dependem
 * apenas destes tipos.
 */

import type { Policy } from "./policy";

export type Role = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: Role;
  content: string;
  /** Rótulo opcional (ex.: nome da tool) para transcrição e debugging. */
  name?: string;
}

/** JSON Schema simplificado: suficiente para gerar prompt e validar entrada. */
export interface JsonSchema {
  type: "object";
  properties: Record<
    string,
    {
      type: "string" | "number" | "boolean" | "integer" | "array" | "object";
      description?: string;
      items?: { type: string };
      enum?: Array<string | number>;
      default?: unknown;
    }
  >;
  required?: string[];
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: JsonSchema;
  /** Ações potencialmente destrutivas (apenas para rotulagem/auditoria). */
  dangerous?: boolean;
  /** Grupo lógico: fs | shell | vcs | net | lab | meta */
  group: "fs" | "shell" | "vcs" | "net" | "lab" | "meta";
}

export interface ToolResult {
  ok: boolean;
  output: string;
  meta?: Record<string, unknown>;
}

export interface ToolContext {
  workspace: string;
  sessionId: string;
  config: AgentConfig;
  policy: Policy;
  /** Logger que também grava no audit log do sessão. */
  log: (message: string, data?: Record<string, unknown>) => void;
}

export interface Tool {
  spec: ToolSpec;
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export interface ModelRequest {
  messages: ChatMessage[];
  tools?: ToolSpec[];
  maxTokens?: number;
  temperature?: number;
  stop?: string[];
}

export interface ModelResponse {
  text: string;
  usage?: { prompt: number; completion: number };
  /** Identificador livre para telemetria (ex.: "local:m5coder-0.1"). */
  model?: string;
}

export interface ModelAdapter {
  id: string;
  complete(req: ModelRequest): Promise<ModelResponse>;
}

export type Autonomy = "full" | "confirm" | "plan";

export interface AgentConfig {
  workspace: string;
  autonomy: Autonomy;
  model: {
    kind: "local" | "http";
    /** Caminho do checkpoint local. */
    path?: string;
    /** Endpoint OpenAI-compatible (Ollama, LM Studio, vLLM, etc.). */
    baseUrl?: string;
    name?: string;
    apiKeyEnv?: string;
    maxTokens: number;
    temperature: number;
    topP: number;
  };
  policy: {
    /** Arquivo de escopo autorizado (usado por net/seclab). */
    scopeFile: string;
    /** JSONL de auditoria. */
    auditFile: string;
    /** Rede liberada? Em "full" roda, mas registra escopo não verificado. */
    allowNetwork: boolean;
    /** Comandos que nunca devem rodar, mesmo em autonomia total. */
    denyPatterns: string[];
  };
  limits: {
    maxSteps: number;
    maxToolCalls: number;
    maxWallClockMs: number;
    maxToolOutputChars: number;
    /** Tentativas totais de uma tarefa, incluindo a primeira. */
    maxTaskAttempts: number;
  };
  verify: {
    commands: string[];
    timeoutMs: number;
    enabled: boolean;
  };
  index: {
    enabled: boolean;
    storePath: string;
    maxFiles: number;
    maxFileBytes: number;
  };
}

export interface StepRecord {
  index: number;
  ts: string;
  kind: "model" | "tool" | "verify" | "error" | "final";
  name?: string;
  input?: unknown;
  output?: string;
  ok?: boolean;
  ms?: number;
}

export interface RunResult {
  sessionId: string;
  status: "done" | "max-steps" | "error" | "timeout" | "plan";
  final: string;
  steps: StepRecord[];
  transcriptPath: string;
  changedFiles: string[];
}
