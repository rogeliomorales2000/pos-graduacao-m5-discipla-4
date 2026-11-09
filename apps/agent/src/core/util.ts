import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function newId(prefix = "ses"): string {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`;
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(file: string, value: unknown): void {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

export function appendJsonl(file: string, value: unknown): void {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, JSON.stringify(value) + "\n");
}

export function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

/** Resolve e valida que `target` está dentro de `root` (anti path traversal). */
export function resolveInside(root: string, target: string): string {
  const base = path.resolve(root);
  const full = path.resolve(base, target);
  const rel = path.relative(base, full);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path escapes workspace: ${target}`);
  }
  return full;
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.7);
  const tail = max - head;
  return `${text.slice(0, head)}\n... [${text.length - max} chars truncated] ...\n${text.slice(-tail)}`;
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/**
 * Extrai nomes de arquivos citados na tarefa atual. Serve para travar escritas
 * no alvo pedido quando o modelo tenta editar arquivos não relacionados.
 */
export function extractTargetFiles(text: string): string[] {
  const ext = "ts|tsx|js|jsx|mjs|cjs|py|c|h|cpp|hpp|cc|cs|java|go|rs|php|sql|sh|bash|ps1|json|jsonl|md|html|css|ya?ml|toml|txt";
  const pattern = new RegExp(`(?:[A-Za-z]:[\\\\/])?[A-Za-z0-9_.\\\\/-]+\\.(?:${ext})\\b`, "gi");
  const found = text.match(pattern) ?? [];
  return [
    ...new Set(
      found
        .map((value) => value.replace(/\\/g, "/").replace(/^\.\//, ""))
        .filter((value) => value.length > 0),
    ),
  ];
}

/**
 * Em chat, mantém o alvo do turno anterior quando o usuário usa "ele/esse
 * arquivo" ou um verbo de continuação sem repetir o caminho.
 */
export function resolveChatTargets(text: string, previous: string[] = []): string[] {
  const explicit = extractTargetFiles(text);
  if (explicit.length > 0) return explicit;
  if (previous.length === 0) return [];

  const asksNewFile =
    /\b(novo|nova|outro|outra)\s+(arquivo|file)\b|\b(arquivo|file)\s+(novo|nova|outro|outra)\b/i.test(text)
    || /\bcrie\s+(um|o)\s+(arquivo|file)\b/i.test(text);
  if (asksNewFile) return [];

  const anaphora =
    /\b(ele|ela|esse|essa|este|esta|isso|mesmo|mesma|acima|nele|nela|dele|dela|o arquivo|esse arquivo|este arquivo|arquivo atual)\b/i.test(text);
  const continuation =
    /^\s*(adicione|inclua|implemente|corrija|ajuste|melhore|refatore|remova|renomeie|mude|altere|edite|modifique|continue|prossiga|faça|faca|coloque|troque|rode|execute|teste|salve|grave|sim|ok|pode)\b/i.test(text);
  return anaphora || continuation ? previous : [];
}

export function hashString(input: string): number {
  // FNV-1a 32-bit
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function findUp(start: string, names: string[], stopAt?: string): string | null {
  let dir = path.resolve(start);
  const stop = stopAt ? path.resolve(stopAt) : null;
  for (;;) {
    for (const name of names) {
      if (fs.existsSync(path.join(dir, name))) return path.join(dir, name);
    }
    if (stop && dir === stop) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function flatten<T>(groups: T[][]): T[] {
  return groups.flat();
}

export function hashFile(file: string): string {
  const buf = fs.readFileSync(file);
  return crypto.createHash("sha1").update(buf).digest("hex");
}

export function template(tpl: string, vars: Record<string, string | number>): string {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_m, key: string) =>
    key in vars ? String(vars[key]) : `{{${key}}}`,
  );
}
