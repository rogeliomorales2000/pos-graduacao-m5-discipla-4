/**
 * Registro das linguagens suportadas pelo gerador de dataset.
 *
 * Cada gerador devolve amostras determinísticas; o registro apenas centraliza
 * os imports e a seleção por chave para o CLI e os testes.
 */
import type { CodeSample } from "./types.ts";
import { generate as generateTs } from "./languages/ts.ts";
import { generate as generatePy } from "./languages/py.ts";
import { generate as generateC } from "./languages/c.ts";
import { generate as generateCpp } from "./languages/cpp.ts";
import { generate as generateSh } from "./languages/sh.ts";
import { generate as generatePs1 } from "./languages/ps1.ts";
import { generate as generatePhp } from "./languages/php.ts";
import { generate as generateSql } from "./languages/sql.ts";
import { generate as generateAsmX86 } from "./languages/asm-x86_64.ts";
import { generate as generateAsmArm } from "./languages/asm-arm64.ts";
import { generate as generateJava } from "./languages/java.ts";
import { generate as generateCs } from "./languages/cs.ts";
import { generate as generateRust } from "./languages/rust.ts";
import { generate as generateGo } from "./languages/go.ts";

export interface LanguageGenerator {
  key: string;
  label: string;
  generate(): CodeSample[];
}

export const LANGUAGES: readonly LanguageGenerator[] = [
  { key: "ts", label: "TypeScript/JavaScript", generate: generateTs },
  { key: "py", label: "Python", generate: generatePy },
  { key: "c", label: "C", generate: generateC },
  { key: "cpp", label: "C++", generate: generateCpp },
  { key: "sh", label: "Shell/Bash", generate: generateSh },
  { key: "ps1", label: "PowerShell", generate: generatePs1 },
  { key: "php", label: "PHP", generate: generatePhp },
  { key: "sql", label: "SQL", generate: generateSql },
  { key: "asm-x86_64", label: "Assembly x86-64", generate: generateAsmX86 },
  { key: "asm-arm64", label: "Assembly ARM64", generate: generateAsmArm },
  { key: "java", label: "Java", generate: generateJava },
  { key: "cs", label: "C#", generate: generateCs },
  { key: "rust", label: "Rust", generate: generateRust },
  { key: "go", label: "Go", generate: generateGo },
];

export const LANGUAGE_KEYS: readonly string[] = LANGUAGES.map((item) => item.key);

export function findLanguage(key: string): LanguageGenerator | undefined {
  return LANGUAGES.find((item) => item.key.toLowerCase() === key.toLowerCase());
}

export interface GenerateAllOptions {
  /** Limite por linguagem; os geradores produzem 800 combinações. */
  perLanguage?: number;
  /** Subconjunto de chaves; por padrão todas. */
  only?: readonly string[];
}

export interface GeneratedLanguage {
  key: string;
  label: string;
  samples: CodeSample[];
  /** Todas as combinações disponíveis antes da aplicação do limite. */
  full: CodeSample[];
  requested: number;
  available: number;
  /** Verdadeiro quando o limite pedido excede as combinações disponíveis. */
  capped: boolean;
}

export function generateAll(options: GenerateAllOptions = {}): GeneratedLanguage[] {
  const requested = options.perLanguage ?? 800;
  if (!Number.isInteger(requested) || requested <= 0) {
    throw new Error(`perLanguage must be a positive integer, got ${requested}`);
  }
  const selected = options.only && options.only.length > 0
    ? options.only.map((key) => {
        const found = findLanguage(key);
        if (!found) {
          throw new Error(
            `unknown language "${key}" (known: ${LANGUAGE_KEYS.join(", ")})`,
          );
        }
        return found;
      })
    : [...LANGUAGES];

  return selected.map((generator) => {
    const all = generator.generate();
    const samples = all.slice(0, requested);
    return {
      key: generator.key,
      label: generator.label,
      samples,
      full: all,
      requested,
      available: all.length,
      capped: requested > all.length,
    };
  });
}
