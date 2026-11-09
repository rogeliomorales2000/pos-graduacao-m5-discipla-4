import fs from "node:fs";
import path from "node:path";

export interface Corpus {
  text: string;
  files: number;
  samples: number;
  languages: Record<string, number>;
}

function readJsonl(file: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(file)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as Record<string, unknown>);
    } catch {
      /* linha inválida é ignorada */
    }
  }
  return out;
}

/**
 * Carrega o corpus de treino em rodízio entre as linguagens.
 *
 * O diretório `all/` é ignorado de propósito: ele é a concatenação dos demais.
 * Antes, `all/train.jsonl` era lido como se fosse uma linguagem e consumia o
 * orçamento inteiro de caracteres, treinando apenas as primeiras linguagens
 * em ordem alfabética. O rodízio garante que um orçamento limitado cubra todas.
 */
export function loadCorpus(dataDir: string, maxChars: number): Corpus {
  const parts: string[] = [];
  const languages: Record<string, number> = {};
  let files = 0;
  let samples = 0;
  let chars = 0;

  const add = (text: string): boolean => {
    if (chars >= maxChars) return false;
    if (chars + text.length > maxChars) return false;
    parts.push(text);
    chars += text.length;
    return true;
  };

  const addRow = (language: string, row: Record<string, unknown>): boolean => {
    const instruction = String(row.instruction ?? "");
    const output = String(row.output ?? "");
    if (!instruction || !output) return true;
    const ok = add(`### USER\n${instruction}\n\n### ASSISTANT\n${output}\n\n`);
    if (!ok) return false;
    samples += 1;
    languages[language] = (languages[language] ?? 0) + 1;
    return true;
  };

  if (fs.existsSync(dataDir)) {
    const datasets: Array<{ language: string; rows: Array<Record<string, unknown>> }> = [];
    for (const entry of fs.readdirSync(dataDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === "all") continue;
      const file = path.join(dataDir, entry.name, "train.jsonl");
      if (!fs.existsSync(file)) continue;
      const rows = readJsonl(file);
      if (rows.length === 0) continue;
      datasets.push({ language: entry.name, rows });
    }
    datasets.sort((a, b) => a.language.localeCompare(b.language));
    files = datasets.length;

    // Rodízio por índice de linha: 1ª amostra de cada linguagem, depois a 2ª...
    outer: for (let index = 0; ; index++) {
      let progressed = false;
      for (const dataset of datasets) {
        const row = dataset.rows[index];
        if (!row) continue;
        progressed = true;
        if (!addRow(dataset.language, row)) break outer;
      }
      if (!progressed) break;
    }

    // Compatibilidade com diretórios antigos que só tinham `all/`.
    const allTrain = path.join(dataDir, "all", "train.jsonl");
    if (samples === 0 && fs.existsSync(allTrain)) {
      files += 1;
      for (const row of readJsonl(allTrain)) {
        if (!addRow("all", row)) break;
      }
    }
  }

  // Fallback: corpus de texto do mini-gpt.
  if (samples === 0) {
    const fallback = path.resolve("dataset", "mini-gpt", "train");
    if (fs.existsSync(fallback)) {
      for (const file of fs.readdirSync(fallback).filter((name) => name.endsWith(".txt"))) {
        add(fs.readFileSync(path.join(fallback, file), "utf8"));
        files += 1;
      }
    }
  }

  // Último recurso: amostra embutida mantém o pipeline testável.
  if (samples === 0 && parts.length === 0) {
    add(
      [
        "### USER\nEscreva uma função TypeScript que soma dois números.\n\n### ASSISTANT\n```ts\nexport function add(a: number, b: number): number {\n  return a + b;\n}\n```\n",
        "### USER\nCrie um servidor HTTP mínimo em Node.\n\n### ASSISTANT\n```ts\nimport http from \"node:http\";\nconst server = http.createServer((_req, res) => res.end(\"ok\"));\nserver.listen(3000);\n```\n",
      ].join("\n"),
    );
  }

  return { text: parts.join("\n"), files, samples, languages };
}
