import { spawn } from "node:child_process";
import { Tool } from "../core/types";
import { truncate } from "../core/util";

const ALLOWED = new Set([
  "status", "diff", "log", "show", "branch", "add", "restore", "stash",
  "rev-parse", "ls-files", "blame", "checkout", "switch", "commit", "tag",
]);

const BLOCKED_ARGS = ["--force", "-f", "clean", "reset"];

export function normalizeGitArgs(input: unknown): string[] {
  const args = Array.isArray(input)
    ? input.map((a) => String(a))
    : typeof input === "string"
      ? input.split(/\s+/).filter(Boolean)
      : [];
  // `git branch list` cria uma branch chamada "list". O modelo costuma
  // usar isso querendo listar; normalize para a forma somente-leitura.
  if (args[0] === "branch" && args[1] === "list") args.splice(1, 1, "--list");
  return args;
}

export async function runGit(
  cwd: string,
  args: string[],
  timeoutMs = 60_000,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
    }, timeoutMs);
    child.stdout.on("data", (b: Buffer) => (stdout += b.toString("utf8")));
    child.stderr.on("data", (b: Buffer) => (stderr += b.toString("utf8")));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

export const gitTool: Tool = {
  spec: {
    name: "git",
    group: "vcs",
    dangerous: true,
    description:
      "Executa git no workspace. Subcomandos permitidos: status, diff, log, show, branch, add, restore, stash, rev-parse, ls-files, blame, checkout, switch, commit, tag.",
    parameters: {
      type: "object",
      properties: {
        args: {
          type: "array",
          items: { type: "string" },
          description: 'Argumentos, ex.: ["status","--short"] ou ["diff","--","src/x.ts"].',
        },
      },
      required: ["args"],
    },
  },
  async run(input, ctx) {
    const args = normalizeGitArgs(input.args);
    if (args.length === 0) return { ok: false, output: "Informe args." };
    const sub = args[0];
    if (!ALLOWED.has(sub)) return { ok: false, output: `Subcomando git não permitido: ${sub}` };
    if (args.some((a) => BLOCKED_ARGS.includes(a))) {
      return { ok: false, output: "Argumento bloqueado (--force/-f/clean/reset)." };
    }

    ctx.policy.audit({ type: "git", sessionId: ctx.sessionId, args });
    const result = await runGit(ctx.workspace, args);
    const body = [
      `exit=${result.code}`,
      result.stdout.trim(),
      result.stderr.trim(),
    ]
      .filter(Boolean)
      .join("\n");
    return {
      ok: result.code === 0,
      output: truncate(body || "(sem saída)", ctx.config.limits.maxToolOutputChars),
    };
  },
};
