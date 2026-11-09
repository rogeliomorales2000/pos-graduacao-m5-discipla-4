import { ToolSpec } from "./types";

export interface ParsedCall {
  name: string;
  input: Record<string, unknown>;
  raw: string;
  error?: string;
}

export interface ParsedOutput {
  calls: ParsedCall[];
  final: string | null;
  /** Texto que não virou chamada nem final (raciocínio livre). */
  prose: string;
}

const CALL_BLOCK = /<(tool|call|tool_call)\b[^>]*\bname\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/\1>/gi;
const CALL_JSON = /<(tool_call|tool_call_json)>\s*([\s\S]*?)\s*<\/\1>/gi;
const FINAL_BLOCK = /<final>([\s\S]*?)<\/final>/gi;
const FENCED_JSON = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/gi;

function tryJson(text: string): Record<string, unknown> | null {
  const trimmed = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try {
    const value = JSON.parse(trimmed);
    if (value && typeof value === "object") return value as Record<string, unknown>;
  } catch {
    /* tenta reparos simples abaixo */
  }
  // Modelos pequenos às vezes emitem JSON com aspas simples ou trailing comma.
  const repaired = trimmed
    .replace(/,\s*([}\]])/g, "$1")
    .replace(/'/g, '"');
  try {
    const value = JSON.parse(repaired);
    if (value && typeof value === "object") return value as Record<string, unknown>;
  } catch {
    return null;
  }
  return null;
}

/** Extrai `<tool name="x">{...}</tool>`, `<call ...>`, tags JSON e blocos ```json. */
export function parseModelOutput(text: string, tools: ToolSpec[]): ParsedOutput {
  const known = new Set(tools.map((t) => t.name));
  const calls: ParsedCall[] = [];
  let working = text;

  const pushCall = (name: string, payload: string, raw: string): void => {
    if (!known.has(name)) {
      calls.push({ name, input: {}, raw, error: `tool desconhecida: ${name}` });
      return;
    }
    const input = payload.trim() ? tryJson(payload) : {};
    calls.push({
      name,
      input: input ?? {},
      raw,
      error: input === null ? "JSON inválido na chamada" : undefined,
    });
  };

  working = working.replace(CALL_BLOCK, (raw, _tag: string, name: string, payload: string) => {
    pushCall(name, payload, raw);
    return "";
  });

  working = working.replace(CALL_JSON, (raw, _tag: string, payload: string) => {
    const value = tryJson(payload) ?? {};
    const name = String(value.name ?? value.tool ?? value.tool_name ?? "");
    const input = (value.arguments ?? value.input ?? value.parameters ?? {}) as Record<string, unknown>;
    if (name) calls.push({ name, input, raw, error: known.has(name) ? undefined : `tool desconhecida: ${name}` });
    return "";
  });

  let final: string | null = null;
  working = working.replace(FINAL_BLOCK, (_raw, body: string) => {
    final = (final ?? "") + body;
    return "";
  });

  if (calls.length === 0) {
    let m: RegExpExecArray | null;
    FENCED_JSON.lastIndex = 0;
    while ((m = FENCED_JSON.exec(text)) !== null) {
      const value = tryJson(m[1]);
      if (!value) continue;
      const name = String(value.name ?? value.tool ?? value.tool_name ?? "");
      const input = (value.arguments ?? value.input ?? value.parameters ?? {}) as Record<string, unknown>;
      if (name && known.has(name)) {
        calls.push({ name, input, raw: m[0] });
        working = working.replace(m[0], "");
      }
    }
  }

  // Formato "TOOL: nome\n{...}" — comum em modelos pequenos.
  if (calls.length === 0) {
    const inline = working.match(/^\s*(?:TOOL|ACTION)\s*:\s*([a-z_]+)\s*\n([\s\S]+)$/im);
    if (inline && known.has(inline[1])) {
      const input = tryJson(inline[2]) ?? {};
      calls.push({ name: inline[1], input, raw: inline[0] });
      working = "";
    }
  }

  const prose = working.replace(/\n{3,}/g, "\n\n").trim();
  if (final === null && calls.length === 0 && prose.length > 0) {
    // Sem chamada e sem tag final: o texto é a resposta final.
    final = prose;
  }
  return { calls, final: final === null ? null : final.trim(), prose };
}

/** Valida minimamente os campos obrigatórios de uma chamada. */
export function validateCall(call: ParsedCall, spec: ToolSpec): string | null {
  if (call.error) return call.error;
  for (const key of spec.parameters.required ?? []) {
    if (!(key in call.input)) return `campo obrigatório ausente: ${key}`;
  }
  return null;
}

export function formatToolResult(name: string, result: { ok: boolean; output: string }): string {
  return `<tool_result name="${name}" ok="${result.ok}">\n${result.output}\n</tool_result>`;
}
