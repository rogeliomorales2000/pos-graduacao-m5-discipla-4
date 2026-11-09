import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { Tool, ToolContext } from "../core/types";
import { truncate } from "../core/util";

export interface ShellRunOptions {
  command: string;
  cwd: string;
  timeoutMs: number;
  shell?: "powershell" | "bash" | "cmd";
  env?: Record<string, string>;
}

export interface ShellRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  shell: string;
  /** Ajustes aplicados para compatibilidade (ex.: && -> ; no PowerShell 5.1). */
  notes?: string[];
}

/**
 * Modelos pequenos costumam emitir comandos em estilo Unix. No Windows
 * PowerShell 5.1, `&&` e `cd /c/...` falham. Convertemos os casos seguros e
 * registramos a nota para o modelo entender por que o comando mudou.
 */
export function normalizePowerShellCommand(command: string): { command: string; notes: string[] } {
  let normalized = command;
  const notes: string[] = [];

  normalized = normalized.replace(
    /(^|[\s;])cd\s+\/mnt\/([a-zA-Z])\/([^;&|]+)/g,
    (_match, prefix: string, drive: string, rest: string) => {
      const target = `${drive.toUpperCase()}:/${rest.trim()}`;
      notes.push(`caminho WSL convertido: ${target}`);
      return `${prefix}Set-Location '${target}'`;
    },
  );
  normalized = normalized.replace(
    /(^|[\s;])cd\s+\/([a-zA-Z])\/([^;&|]+)/g,
    (_match, prefix: string, drive: string, rest: string) => {
      const target = `${drive.toUpperCase()}:/${rest.trim()}`;
      notes.push(`caminho Unix convertido: ${target}`);
      return `${prefix}Set-Location '${target}'`;
    },
  );
  if (normalized.includes("&&")) {
    normalized = normalized.replace(/\s*&&\s*/g, "; ");
    notes.push("operador && convertido para ; no PowerShell 5.1");
  }
  if (normalized.includes("||")) {
    normalized = normalized.replace(/\s*\|\|\s*/g, "; ");
    notes.push("operador || convertido para ; no PowerShell 5.1");
  }
  return { command: normalized, notes };
}

function shellInvocation(shell: "powershell" | "bash" | "cmd", command: string): { file: string; args: string[] } {
  if (shell === "bash") {
    const bash = process.env.M5_BASH || "bash";
    return { file: bash, args: ["-lc", command] };
  }
  if (shell === "cmd") {
    return { file: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", command] };
  }
  return {
    file: "powershell.exe",
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
  };
}

export function defaultShell(): "powershell" | "bash" {
  return os.platform() === "win32" ? "powershell" : "bash";
}

export async function runShell(options: ShellRunOptions): Promise<ShellRunResult> {
  const shell = options.shell ?? defaultShell();
  const normalized = shell === "powershell" && process.platform === "win32"
    ? normalizePowerShellCommand(options.command)
    : { command: options.command, notes: [] };
  const invocation = shellInvocation(shell, normalized.command);
  const started = Date.now();

  return new Promise<ShellRunResult>((resolve) => {
    const child = spawn(invocation.file, invocation.args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env ?? {}), M5_SHELL: "1" },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const cap = 2_000_000;

    child.stdout.on("data", (buf: Buffer) => {
      if (stdout.length < cap) stdout += buf.toString("utf8");
    });
    child.stderr.on("data", (buf: Buffer) => {
      if (stderr.length < cap) stderr += buf.toString("utf8");
    });

    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === "win32" && child.pid) {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
      } else {
        child.kill("SIGKILL");
      }
    }, options.timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        code: -1,
        stdout,
        stderr: `${stderr}\n${err.message}`,
        timedOut,
        durationMs: Date.now() - started,
        shell,
        notes: normalized.notes.length ? normalized.notes : undefined,
      });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        code,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - started,
        shell,
        notes: normalized.notes.length ? normalized.notes : undefined,
      });
    });
  });
}

export const shellTool: Tool = {
  spec: {
    name: "shell",
    group: "shell",
    dangerous: true,
    description:
      "Executa um comando no workspace (PowerShell no Windows, bash no Linux). classificação de risco vai para o audit log. Use para build, testes e inspeção.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Comando a executar." },
        cwd: { type: "string", description: "Diretório relativo ao workspace." },
        timeoutMs: { type: "integer", description: "Timeout em ms (padrão 120000)." },
        shell: { type: "string", enum: ["powershell", "bash", "cmd"] },
      },
      required: ["command"],
    },
  },
  async run(input, ctx) {
    const command = String(input.command ?? "").trim();
    if (!command) return { ok: false, output: "Comando vazio." };

    const decision = ctx.policy.classifyCommand(command);
    ctx.policy.audit({
      type: "shell",
      sessionId: ctx.sessionId,
      command,
      classification: decision.classification,
      reasons: decision.reasons,
      scope: decision.scope,
    });

    if (decision.classification === "denied") {
      return { ok: false, output: `Bloqueado pela política: ${decision.reasons.join("; ")}` };
    }

    const cwd = input.cwd ? path.resolve(ctx.workspace, String(input.cwd)) : ctx.workspace;
    if (!cwd.startsWith(path.resolve(ctx.workspace))) {
      return { ok: false, output: "cwd fora do workspace." };
    }

    const timeoutMs = Math.max(1_000, Number(input.timeoutMs ?? 120_000));
    const result = await runShell({
      command,
      cwd,
      timeoutMs,
      shell: (input.shell as "powershell" | "bash" | "cmd" | undefined) ?? defaultShell(),
    });

    const header = [
      `exit=${result.code} shell=${result.shell} ${result.durationMs}ms${result.timedOut ? " TIMEOUT" : ""}`,
      decision.reasons.length ? `policy=${decision.classification} (${decision.reasons.join("; ")})` : "",
      result.notes?.length ? `notas=${result.notes.join("; ")}` : "",
    ]
      .filter(Boolean)
      .join(" | ");

    const body = [header, result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
    ctx.log(`shell ${command.slice(0, 120)}`, { code: result.code, classification: decision.classification });

    return {
      ok: !result.timedOut && result.code === 0,
      output: truncate(body || "(sem saída)", ctx.config.limits.maxToolOutputChars),
      meta: { code: result.code, timedOut: result.timedOut, classification: decision.classification },
    };
  },
};
