import { Severity, severity } from "./cvss";

/**
 * Relatório Markdown de achados autorizados.
 *
 * O relatório é deliberadamente sóbrio: descreve evidência observada,
 * impacto e remediação. Não inclui comandos de ataque nem dados sensíveis.
 */

export interface Finding {
  title: string;
  asset: string;
  severity?: Severity | string;
  cvss: number;
  evidence: string | string[];
  impact: string;
  remediation: string;
  refs?: string[];
}

export interface ReportMeta {
  title?: string;
  author?: string;
  date?: string;
  authorizationRef?: string;
  scope?: string;
  notes?: string;
}

export interface ReportInput {
  findings: Finding[];
  meta?: ReportMeta;
}

function text(value: unknown, fallback = "—"): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  return fallback;
}

function evidenceLines(finding: Finding): string[] {
  if (Array.isArray(finding.evidence)) {
    return finding.evidence.map((line) => String(line));
  }
  return String(finding.evidence ?? "").split(/\r?\n/);
}

function tableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}

function findingSeverity(finding: Finding): string {
  if (typeof finding.severity === "string" && finding.severity.trim()) {
    return finding.severity.trim();
  }
  try {
    return severity(finding.cvss);
  } catch {
    return "Indefinida";
  }
}

function countBySeverity(findings: Finding[]): Record<string, number> {
  const order: Severity[] = ["Critical", "High", "Medium", "Low", "None"];
  const counts: Record<string, number> = {
    Critical: 0,
    High: 0,
    Medium: 0,
    Low: 0,
    None: 0,
  };
  for (const finding of findings) {
    const label = findingSeverity(finding);
    if (!(label in counts)) counts[label] = 0;
    counts[label] += 1;
  }
  return Object.fromEntries(
    [...order.filter((key) => key in counts), ...Object.keys(counts).filter((key) => !order.includes(key as Severity))]
      .map((key) => [key, counts[key]]),
  );
}

export function buildReport(findings: Finding[], meta: ReportMeta = {}): string {
  const title = text(meta.title, "Relatório de Segurança");
  const date = text(meta.date, new Date().toISOString().slice(0, 10));
  const counts = countBySeverity(findings);
  const highest = findings.reduce((max, finding) => Math.max(max, Number(finding.cvss) || 0), 0);

  const lines: string[] = [
    `# ${title}`,
    "",
    `- Data: ${date}`,
    `- Autor: ${text(meta.author, "M5 Agent — laboratório local")}`,
    `- Autorização: ${text(meta.authorizationRef, "não informada")}`,
    `- Escopo: ${text(meta.scope, "não informado")}`,
    `- Achados: ${findings.length}`,
    "",
    "## Sumário Executivo",
    "",
    `Foram registrados **${findings.length}** achado(s) no escopo autorizado. ` +
      `A pontuação CVSS 3.1 mais alta foi **${highest.toFixed(1)}** (${findings.length ? findingSeverity(findings.reduce((a, b) => ((Number(a.cvss) || 0) >= (Number(b.cvss) || 0) ? a : b))) : "None"}).`,
    "",
    "| Severidade | Quantidade |",
    "| --- | ---: |",
  ];

  for (const [label, count] of Object.entries(counts)) {
    lines.push(`| ${label} | ${count} |`);
  }

  lines.push("");
  if (findings.length === 0) {
    lines.push("Nenhum achado foi registrado nesta avaliação.");
  } else {
    lines.push(
      "Priorize os itens de severidade Critical/High e confirme cada evidência com o dono do ativo antes de qualquer mudança.",
    );
  }
  if (meta.notes) {
    lines.push("");
    lines.push(text(meta.notes));
  }

  lines.push("", "## Tabela de Achados", "");
  if (findings.length === 0) {
    lines.push("Sem achados para tabelar.");
  } else {
    lines.push("| # | Severidade | CVSS | Achado | Ativo |");
    lines.push("| ---: | --- | ---: | --- | --- |");
    findings.forEach((finding, index) => {
      lines.push(
        `| ${index + 1} | ${tableCell(findingSeverity(finding))} | ${(Number(finding.cvss) || 0).toFixed(1)} | ${tableCell(text(finding.title))} | ${tableCell(text(finding.asset))} |`,
      );
    });
  }

  lines.push("", "## Detalhes dos Achados", "");
  if (findings.length === 0) {
    lines.push("Nada a detalhar.");
  } else {
    findings.forEach((finding, index) => {
      lines.push(`### ${index + 1}. ${text(finding.title)}`);
      lines.push("");
      lines.push(`- **Ativo:** ${text(finding.asset)}`);
      lines.push(`- **Severidade:** ${findingSeverity(finding)}`);
      lines.push(`- **CVSS 3.1:** ${(Number(finding.cvss) || 0).toFixed(1)}`);
      lines.push("");
      lines.push("**Impacto**");
      lines.push("");
      lines.push(text(finding.impact));
      lines.push("");
      lines.push("**Remediação**");
      lines.push("");
      lines.push(text(finding.remediation));
      if (finding.refs && finding.refs.length > 0) {
        lines.push("");
        lines.push("**Referências**");
        lines.push("");
        for (const ref of finding.refs) lines.push(`- ${text(ref)}`);
      }
      lines.push("");
    });
  }

  lines.push("## Apêndice de Evidências", "");
  if (findings.length === 0) {
    lines.push("Nenhuma evidência coletada.");
  } else {
    findings.forEach((finding, index) => {
      lines.push(`### Evidência ${index + 1} — ${text(finding.title)}`);
      lines.push("");
      lines.push("```text");
      for (const line of evidenceLines(finding)) lines.push(line);
      lines.push("```");
      lines.push("");
    });
  }

  lines.push(
    "---",
    "",
    "Relatório gerado para fins de avaliação autorizada. Revise o escopo e remova dados sensíveis antes de compartilhar.",
    "",
  );
  return lines.join("\n");
}

export function renderReport(findings: Finding[], meta?: ReportMeta): string;
export function renderReport(input: ReportInput): string;
export function renderReport(
  findingsOrInput: Finding[] | ReportInput,
  meta: ReportMeta = {},
): string {
  if (Array.isArray(findingsOrInput)) return buildReport(findingsOrInput, meta);
  if (!findingsOrInput || !Array.isArray(findingsOrInput.findings)) {
    throw new Error("renderReport exige uma lista de achados");
  }
  return buildReport(findingsOrInput.findings, findingsOrInput.meta ?? {});
}

export const generateReport = renderReport;
export const buildMarkdownReport = renderReport;
