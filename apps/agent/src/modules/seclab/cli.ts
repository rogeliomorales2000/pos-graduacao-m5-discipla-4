import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAuthorization,
  isExpired,
  loadAuthorization,
  parseScopeTarget,
  saveAuthorization,
  ScopeTarget,
  assertInScope,
} from "./scope";
import { appendAudit, readAudit, verifyChain } from "./audit";
import { generateOverflowLab, mitigationsTable } from "./overflow";
import {
  cvss31Details,
  cvss4Hint,
  formatVector,
  parseVector,
  severity,
} from "./cvss";
import { buildReconChecklist, renderReconChecklist, ReconKind } from "./recon";
import { generateReport, Finding } from "./report";

/**
 * CLI do laboratório de segurança local.
 *
 * Nenhum comando executa reconhecimento: o CLI apenas cria/valida escopo,
 * gera material didático, calcula CVSS e imprime checklists/relatórios.
 * A verificação de escopo é obrigatória antes de qualquer checklist.
 */

interface ParsedArgs {
  positionals: string[];
  flags: Map<string, Array<string | boolean>>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, Array<string | boolean>>();
  const push = (key: string, value: string | boolean): void => {
    const list = flags.get(key) ?? [];
    list.push(value);
    flags.set(key, list);
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (arg.startsWith("--") && arg.length > 2) {
      const body = arg.slice(2);
      if (body.startsWith("no-")) {
        push(body.slice(3).toLowerCase(), false);
        continue;
      }
      const equals = body.indexOf("=");
      if (equals > 0) {
        push(body.slice(0, equals).toLowerCase(), body.slice(equals + 1));
        continue;
      }
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("--")) {
        push(body.toLowerCase(), next);
        index++;
      } else {
        push(body.toLowerCase(), true);
      }
      continue;
    }
    positionals.push(arg);
  }
  return { positionals, flags };
}

function allStrings(flags: Map<string, Array<string | boolean>>, name: string): string[] {
  return (flags.get(name) ?? []).filter((value): value is string => typeof value === "string");
}

function lastString(
  flags: Map<string, Array<string | boolean>>,
  name: string,
): string | undefined {
  const values = allStrings(flags, name);
  return values.length > 0 ? values[values.length - 1] : undefined;
}

function boolFlag(
  flags: Map<string, Array<string | boolean>>,
  name: string,
  fallback: boolean,
): boolean {
  const values = flags.get(name);
  if (!values || values.length === 0) return fallback;
  const last = values[values.length - 1];
  if (typeof last === "boolean") return last;
  return !["false", "0", "no", "nao", "não"].includes(last.toLowerCase());
}

function defaultScopeFile(): string {
  return (
    process.env.M5_SECLAB_SCOPE ??
    path.resolve(process.cwd(), ".m5", "seclab", "authorization.json")
  );
}

function defaultAuditFile(): string {
  return (
    process.env.M5_SECLAB_AUDIT ??
    path.resolve(process.cwd(), ".m5", "seclab", "audit.jsonl")
  );
}

function scopeFile(flags: Map<string, Array<string | boolean>>): string {
  return path.resolve(lastString(flags, "scope") ?? defaultScopeFile());
}

function auditFile(flags: Map<string, Array<string | boolean>>): string {
  return path.resolve(lastString(flags, "audit") ?? defaultAuditFile());
}

function usage(): string {
  return `M5 seclab — laboratório de segurança local e autorizado

Uso:
  seclab scope new --by "nome" --ref "documento" --targets host:127.0.0.1 --days 1
  seclab scope check <alvo> [--scope arquivo.json]
  seclab audit verify [--audit audit.jsonl]
  seclab lab overflow --buffer 64 [--canary] [--nx] [--pie] [--out pasta]
  seclab cvss --vector "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"
  seclab recon --target 127.0.0.1 --kind host [--scope arquivo.json]

Tipos de alvo aceitos: host, cidr, url, device, repo.
Tipos de recon: web, host, rede, dispositivo.

Segurança:
  - o escopo precisa estar vigente e cobrir o alvo;
  - o CLI nunca executa os comandos de recon, apenas os apresenta;
  - o laboratório é local e não gera payload de execução.
`;
}

function printScope(auth: ReturnType<typeof createAuthorization>): void {
  console.log(`Autorização: ${auth.id}`);
  console.log(`Responsável: ${auth.authorizedBy}`);
  console.log(`Referência: ${auth.authorizationRef}`);
  console.log(`Válida de ${auth.startsAt} até ${auth.expiresAt}`);
  console.log(`Expirada: ${isExpired(auth) ? "sim" : "não"}`);
  console.log("Alvos:");
  for (const target of auth.targets) {
    console.log(`  - ${target.kind}:${target.value}${target.note ? ` (${target.note})` : ""}`);
  }
}

function commandScopeNew(args: ParsedArgs): number {
  const by = lastString(args.flags, "by");
  const ref = lastString(args.flags, "ref");
  if (!by) throw new Error('--by "responsável" é obrigatório');
  if (!ref) throw new Error('--ref "documento" é obrigatório');

  const specs = [...allStrings(args.flags, "targets"), ...allStrings(args.flags, "target")]
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  if (specs.length === 0) {
    throw new Error("informe ao menos um --targets (ex.: --targets host:127.0.0.1)");
  }

  const targets: ScopeTarget[] = specs.map(parseScopeTarget);
  const daysRaw = lastString(args.flags, "days") ?? "1";
  const days = Number(daysRaw);
  if (!Number.isFinite(days) || days <= 0) throw new Error(`--days inválido: ${daysRaw}`);

  const auth = createAuthorization({
    authorizedBy: by,
    authorizationRef: ref,
    targets,
    days,
    startsAt: lastString(args.flags, "starts-at"),
    expiresAt: lastString(args.flags, "expires-at"),
    notes: lastString(args.flags, "notes") ?? "",
  });

  const file = path.resolve(
    lastString(args.flags, "out") ??
      lastString(args.flags, "scope") ??
      defaultScopeFile(),
  );
  saveAuthorization(file, auth);
  appendAudit(auditFile(args.flags), {
    type: "scope.created",
    authorizationId: auth.id,
    authorizedBy: auth.authorizedBy,
    authorizationRef: auth.authorizationRef,
    startsAt: auth.startsAt,
    expiresAt: auth.expiresAt,
    targets: auth.targets,
  });

  console.log(`Autorização criada: ${file}`);
  printScope(auth);
  return 0;
}

function commandScopeCheck(args: ParsedArgs): number {
  const target = args.positionals[2] ?? lastString(args.flags, "target");
  if (!target) throw new Error("uso: scope check <alvo>");
  const file = scopeFile(args.flags);
  const auth = loadAuthorization(file);
  const match = assertInScope(auth, target);
  console.log(`DENTRO DO ESCOPO: ${target}`);
  console.log(`Coberto por: ${match.kind}:${match.value}`);
  console.log(`Autorização: ${auth.id} (${auth.authorizationRef}), expira em ${auth.expiresAt}`);
  return 0;
}

function commandAuditVerify(args: ParsedArgs): number {
  const file = auditFile(args.flags);
  const result = verifyChain(file);
  if (result.valid) {
    console.log(`Cadeia válida: ${result.entries} evento(s) em ${file}`);
    return 0;
  }
  console.log(`CADEIA INVÁLIDA em ${file}`);
  console.log(`Registro: ${result.brokenAt ?? "?"} (linha ${(result.brokenIndex ?? 0) + 1})`);
  console.log(`Motivo: ${result.reason ?? "desconhecido"}`);
  return 1;
}

function commandLabOverflow(args: ParsedArgs): number {
  const bufferRaw = lastString(args.flags, "buffer") ?? "64";
  const bufferSize = Number(bufferRaw);
  const lab = generateOverflowLab({
    bufferSize,
    canary: boolFlag(args.flags, "canary", true),
    nx: boolFlag(args.flags, "nx", true),
    pie: boolFlag(args.flags, "pie", true),
  });

  const outDir = lastString(args.flags, "out");
  if (outDir) {
    const dir = path.resolve(outDir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "vulnerable.c"), lab.files["vulnerable.c"], "utf8");
    fs.writeFileSync(path.join(dir, "mitigated.c"), lab.files["mitigated.c"], "utf8");
    fs.writeFileSync(path.join(dir, "lab.gdb"), lab.gdbScript, "utf8");
    console.log(`Arquivos escritos em: ${dir}`);
  }

  console.log(`# Laboratório de estouro de pilha (buffer ${lab.bufferSize} bytes)`);
  console.log("");
  console.log("## vulnerable.c");
  console.log("```c");
  console.log(lab.files["vulnerable.c"].trimEnd());
  console.log("```");
  console.log("");
  console.log("## mitigated.c");
  console.log("```c");
  console.log(lab.files["mitigated.c"].trimEnd());
  console.log("```");
  console.log("");
  console.log("## Compilação (gcc/WSL)");
  for (const command of lab.commands.gccWsl) console.log(`  ${command}`);
  console.log("");
  console.log("## Compilação (MSVC)");
  for (const command of lab.commands.msvc) console.log(`  ${command}`);
  console.log("");
  console.log("## gdb/pwndbg");
  console.log("```text");
  console.log(lab.gdbScript.trimEnd());
  console.log("```");
  console.log("");
  console.log("## Mitigações");
  for (const row of mitigationsTable()) {
    console.log(`- ${row.name}: ${row.howToCheck}`);
  }
  console.log("");
  console.log("## Avisos");
  for (const note of lab.notes) console.log(`- ${note}`);
  return 0;
}

function commandCvss(args: ParsedArgs): number {
  const vector = lastString(args.flags, "vector") ?? args.positionals[1];
  if (!vector) throw new Error('uso: cvss --vector "CVSS:3.1/..."');
  const metrics = parseVector(vector);
  const details = cvss31Details(metrics);
  if (boolFlag(args.flags, "json", false)) {
    console.log(
      JSON.stringify(
        {
          vector: formatVector(metrics),
          score: details.score,
          severity: severity(details.score),
          impact: Number(details.impact.toFixed(4)),
          exploitability: Number(details.exploitability.toFixed(4)),
          hint: cvss4Hint(),
        },
        null,
        2,
      ),
    );
    return 0;
  }
  console.log(`Vetor: ${formatVector(metrics)}`);
  console.log(`Score base: ${details.score.toFixed(1)} (${severity(details.score)})`);
  console.log(`Impacto: ${details.impact.toFixed(4)}`);
  console.log(`Exploitabilidade: ${details.exploitability.toFixed(4)}`);
  console.log("");
  console.log(cvss4Hint());
  return 0;
}

function commandRecon(args: ParsedArgs): number {
  const target = lastString(args.flags, "target") ?? args.positionals[2];
  if (!target) throw new Error("uso: recon --target <alvo> --kind <web|host|rede|dispositivo>");
  const kind = (lastString(args.flags, "kind") ?? "host") as ReconKind;
  const file = scopeFile(args.flags);
  const auth = loadAuthorization(file);

  // buildReconChecklist chama assertInScope; alvo expirado/fora do escopo falha aqui.
  const checklist = buildReconChecklist(auth, target, kind);
  appendAudit(auditFile(args.flags), {
    type: "recon.checklist",
    authorizationId: auth.id,
    authorizationRef: auth.authorizationRef,
    target,
    kind: checklist.kind,
    items: checklist.items.length,
  });

  if (boolFlag(args.flags, "json", false)) {
    console.log(JSON.stringify(checklist, null, 2));
    return 0;
  }
  console.log(renderReconChecklist(checklist));
  return 0;
}

function commandReport(args: ParsedArgs): number {
  const input = lastString(args.flags, "input");
  if (!input) throw new Error("uso: report --input achados.json [--out relatorio.md]");
  const parsed = JSON.parse(fs.readFileSync(path.resolve(input), "utf8")) as
    | Finding[]
    | { findings: Finding[] };
  const findings = Array.isArray(parsed) ? parsed : parsed.findings;
  if (!Array.isArray(findings)) throw new Error("JSON precisa ser uma lista de achados ou { findings: [...] }");
  const markdown = generateReport(findings);
  const output = lastString(args.flags, "out");
  if (output) {
    const file = path.resolve(output);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, markdown, "utf8");
    console.log(`Relatório escrito em: ${file}`);
  } else {
    console.log(markdown);
  }
  return 0;
}

export function main(argv: string[] = process.argv.slice(2)): number {
  const args = parseArgs(argv);
  const [command, subcommand] = args.positionals;

  if (!command || command === "help" || command === "--help" || boolFlag(args.flags, "help", false)) {
    console.log(usage());
    return 0;
  }

  try {
    if (command === "scope") {
      if (subcommand === "new") return commandScopeNew(args);
      if (subcommand === "check") return commandScopeCheck(args);
      throw new Error("uso: scope <new|check>");
    }
    if (command === "audit") {
      if (subcommand === "verify") return commandAuditVerify(args);
      throw new Error("uso: audit verify");
    }
    if (command === "lab") {
      if (subcommand === "overflow") return commandLabOverflow(args);
      throw new Error("uso: lab overflow --buffer 64");
    }
    if (command === "cvss") return commandCvss(args);
    if (command === "recon") return commandRecon(args);
    if (command === "report") return commandReport(args);
    throw new Error(`comando desconhecido: ${command}`);
  } catch (error) {
    console.error(`erro: ${(error as Error).message}`);
    if (/fora do escopo|expirada|não está vigente|não está vigente/i.test((error as Error).message)) {
      return 2;
    }
    return 1;
  }
}

const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  process.exitCode = main();
}

export { readAudit };
