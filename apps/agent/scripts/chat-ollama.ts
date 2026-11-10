#!/usr/bin/env node
/**
 * Atalho para o chat offline usando Ollama (OpenAI-compatible).
 *
 *   npm run agent:ollama
 *   $env:M5_WORKSPACE="C:\temp\projeto"; npm run agent:ollama
 *
 * O loop, as tools, a sessão e a auditoria continuam sendo do M5 Agent.
 * O Ollama só fornece o modelo; depois do download ele funciona offline.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const cli = path.join(repoRoot, "apps", "agent", "src", "cli.ts");
const args = process.argv.slice(2);

// npm intercepta flags desconhecidas; o atalho usa M5_WORKSPACE e
// M5_CHAT_MAX_TOKENS por variáveis de ambiente.
if (!args.includes("--max-tokens")) {
  args.push("--max-tokens", process.env.M5_CHAT_MAX_TOKENS ?? "8192");
}

const child = spawn(
  process.execPath,
  ["--import", "tsx", cli, "chat", ...args],
  {
    cwd: repoRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      M5_MODEL_BASE_URL: process.env.M5_MODEL_BASE_URL ?? "http://127.0.0.1:11434/v1",
      M5_MODEL_NAME: process.env.M5_MODEL_NAME ?? "qwen3:4b-instruct-2507-q4_K_M",
      M5_HTTP_TIMEOUT_MS: process.env.M5_HTTP_TIMEOUT_MS ?? "900000",
    },
  },
);

child.on("error", (error) => {
  console.error(`Falha ao iniciar o chat: ${error.message}`);
  process.exit(1);
});
child.on("exit", (code) => {
  process.exit(code ?? 0);
});
