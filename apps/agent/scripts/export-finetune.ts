/**
 * Exporta o dataset de segurança para o formato chat usado no fine-tuning
 * (system/user/assistant) do Qwen e de outros modelos instruct.
 *
 * Entrada:
 *   dataset/security-tune/{train,validation,test}.jsonl
 *
 * Saída:
 *   dataset/finetune/security/{train,validation,test}.jsonl
 *   dataset/finetune/security/manifest.json
 *
 * O protocolo do agente é preservado no system prompt. O dataset continua
 * defensivo e autorizado: não há exploit armado, payload ou C2.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { SecurityTuneSample } from "../src/datasets/security-tune";

export const SECURITY_SYSTEM_PROMPT = [
  "Você é o M5 Security Agent, um agente de segurança defensiva, purple team e red team autorizado.",
  "Você trabalha apenas com escopo aprovado, ativos do inventário e dados sintéticos ou minimizados.",
  "Você não fornece exploit armado, payload, C2 operacional, roubo de credenciais, persistência, evasão ou bypass de terceiros.",
  "Quando o pedido for inseguro, recuse a parte ofensiva e ofereça uma alternativa defensiva ou um teste autorizado em laboratório.",
  "Priorize hipótese, evidência, detecção, resposta, remediação e relatório.",
  "",
  "PROTOCOLO DE FERRAMENTAS:",
  "Para usar uma ferramenta, responda com:",
  '<tool name="nome_da_ferramenta">{"arg":"valor"}</tool>',
  "Para encerrar, responda com:",
  "<final>resposta final</final>",
  "Nunca invente resultados de ferramenta. Nunca peça confirmação para ações já autorizadas.",
].join("\n");

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatSample {
  id: string;
  category: string;
  messages: ChatMessage[];
}

export interface FinetuneManifest {
  version: number;
  createdAt: string;
  format: "chat-jsonl";
  source: string;
  total: number;
  splits: { train: number; validation: number; test: number };
  categories: Record<string, number>;
  sha256: { train: string; validation: string; test: string };
  systemPrompt: string;
  safety: {
    defensive: true;
    authorizedOnly: true;
    noWeaponizedContent: true;
  };
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

export function toChatSample(sample: SecurityTuneSample): ChatSample {
  const context = sample.input.trim() ? `\n\nCONTEXTO:\n${sample.input.trim()}` : "";
  return {
    id: sample.id,
    category: sample.category,
    messages: [
      { role: "system", content: SECURITY_SYSTEM_PROMPT },
      { role: "user", content: `${sample.instruction}${context}` },
      { role: "assistant", content: sample.output },
    ],
  };
}

function readJsonl(file: string): SecurityTuneSample[] {
  const content = fs.readFileSync(file, "utf8");
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as SecurityTuneSample);
}

function writeJsonl(file: string, rows: ChatSample[]): string {
  const content = rows.map((row) => JSON.stringify(row)).join("\n");
  const payload = content ? `${content}\n` : "";
  fs.writeFileSync(file, payload, "utf8");
  return sha256(payload);
}

function getArg(argv: string[], name: string, fallback: string): string {
  const eq = argv.find((arg) => arg.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const index = argv.indexOf(name);
  if (index >= 0 && argv[index + 1] && !argv[index + 1].startsWith("--")) {
    return argv[index + 1];
  }
  return fallback;
}

export function exportFinetuneDataset(dataDir: string, outDir: string): FinetuneManifest {
  const splitNames = ["train", "validation", "test"] as const;
  const rows: Record<(typeof splitNames)[number], ChatSample[]> = {
    train: [],
    validation: [],
    test: [],
  };

  for (const split of splitNames) {
    const input = path.join(dataDir, `${split}.jsonl`);
    if (!fs.existsSync(input)) {
      throw new Error(`arquivo não encontrado: ${input}. Rode npm run agent:security-dataset antes.`);
    }
    rows[split] = readJsonl(input).map(toChatSample);
  }

  fs.mkdirSync(outDir, { recursive: true });
  const hashes = {
    train: writeJsonl(path.join(outDir, "train.jsonl"), rows.train),
    validation: writeJsonl(path.join(outDir, "validation.jsonl"), rows.validation),
    test: writeJsonl(path.join(outDir, "test.jsonl"), rows.test),
  };

  const categories: Record<string, number> = {};
  for (const split of splitNames) {
    for (const row of rows[split]) {
      categories[row.category] = (categories[row.category] ?? 0) + 1;
    }
  }

  const manifest: FinetuneManifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    format: "chat-jsonl",
    source: dataDir,
    total: rows.train.length + rows.validation.length + rows.test.length,
    splits: {
      train: rows.train.length,
      validation: rows.validation.length,
      test: rows.test.length,
    },
    categories,
    sha256: hashes,
    systemPrompt: SECURITY_SYSTEM_PROMPT,
    safety: {
      defensive: true,
      authorizedOnly: true,
      noWeaponizedContent: true,
    },
  };

  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  return manifest;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help")) {
    console.log(
      "Uso: export-finetune.ts [--data dataset/security-tune] [--out dataset/finetune/security]",
    );
    return;
  }

  const dataDir = path.resolve(getArg(argv, "--data", "dataset/security-tune"));
  const outDir = path.resolve(getArg(argv, "--out", "dataset/finetune/security"));
  const manifest = exportFinetuneDataset(dataDir, outDir);

  console.log("== Exportação chat/fine-tuning ==");
  console.log(`origem: ${dataDir}`);
  console.log(`saída: ${outDir}`);
  console.log(`total: ${manifest.total}`);
  console.log(
    `splits: train=${manifest.splits.train} validation=${manifest.splits.validation} test=${manifest.splits.test}`,
  );
  console.log("categorias:");
  for (const [name, count] of Object.entries(manifest.categories).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${name}: ${count}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
