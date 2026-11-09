import fs from "node:fs";
import path from "node:path";
import { AgentConfig } from "./types";
import { runShell } from "../tools/shell";

export interface VerifyStepResult {
  command: string;
  code: number | null;
  ok: boolean;
  output: string;
  durationMs: number;
}

export interface VerifyOutcome {
  ran: boolean;
  ok: boolean;
  steps: VerifyStepResult[];
}

interface PackageJson {
  scripts?: Record<string, string>;
}

/** Detecta comandos de verificação plausíveis para o projeto. */
export function detectVerifyCommands(root: string): string[] {
  const commands: string[] = [];
  const has = (name: string): boolean => fs.existsSync(path.join(root, name));
  const readPackage = (): PackageJson | null => {
    try {
      return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as PackageJson;
    } catch {
      return null;
    }
  };

  if (has("package.json")) {
    const pkg = readPackage();
    const scripts = pkg?.scripts ?? {};
    if (scripts.build) commands.push("npm run build");
    else if (has("tsconfig.json")) commands.push("npx tsc --noEmit");
    if (scripts.test && !scripts.test.includes("no test")) commands.push("npm test");
    if (scripts.lint) commands.push("npm run lint");
  }
  if (has("pyproject.toml") || has("requirements.txt") || has("setup.py")) {
    if (fs.existsSync(path.join(root, "tests")) || has("pytest.ini")) commands.push("python -m pytest -q");
  }
  if (has("Cargo.toml")) commands.push("cargo test --quiet");
  if (has("go.mod")) commands.push("go test ./...");
  if (has("pom.xml")) commands.push("mvn -q -DskipTests compile");
  if (has("build.gradle") || has("build.gradle.kts")) commands.push("gradle -q compileJava");
  if (fs.readdirSync(root).some((f) => f.endsWith(".sln"))) commands.push("dotnet build --nologo -v q");
  if (has("CMakeLists.txt") && fs.existsSync(path.join(root, "build"))) commands.push("cmake --build build");
  if (has("Makefile") && fs.existsSync(path.join(root, "tests"))) commands.push("make -s test");

  return [...new Set(commands)];
}

export async function runVerification(
  config: AgentConfig,
  options: { changed: boolean; signal?: AbortSignal } = { changed: true },
): Promise<VerifyOutcome> {
  if (!config.verify.enabled) return { ran: false, ok: true, steps: [] };
  const commands = config.verify.commands.length
    ? config.verify.commands
    : detectVerifyCommands(config.workspace);
  if (commands.length === 0) return { ran: false, ok: true, steps: [] };

  // Evita rodar build/test quando nada mudou (economiza minutos no CPU).
  if (!options.changed && config.verify.commands.length === 0) {
    return { ran: false, ok: true, steps: [] };
  }

  const steps: VerifyStepResult[] = [];
  for (const command of commands) {
    const result = await runShell({
      command,
      cwd: config.workspace,
      timeoutMs: config.verify.timeoutMs,
      shell: process.platform === "win32" ? "powershell" : "bash",
    });
    const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
    steps.push({
      command,
      code: result.code,
      ok: !result.timedOut && result.code === 0,
      output: output.slice(0, 6_000),
      durationMs: result.durationMs,
    });
    if (result.timedOut || result.code !== 0) break; // para no primeiro erro
  }

  return { ran: true, ok: steps.every((s) => s.ok), steps };
}

export function summarizeVerification(outcome: VerifyOutcome): string {
  if (!outcome.ran) return "Verificação: nenhum comando aplicável detectado.";
  return outcome.steps
    .map((s) => `${s.ok ? "OK" : "FALHOU"} (${s.code}) ${s.command} em ${s.durationMs}ms`)
    .join("\n");
}
