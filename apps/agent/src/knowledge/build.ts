/**
 * Geração do dataset defensivo de conhecimento de segurança.
 *
 * Para cada CVE são produzidas 5 tarefas:
 *   1. explicar a vulnerabilidade;
 *   2. identificar/classificar CWE;
 *   3. avaliar CVSS e severidade;
 *   4. propor mitigação defensiva;
 *   5. escrever regra/teste de detecção genérico.
 *
 * Para cada registro do ExploitDB são produzidas 2 tarefas:
 *   1. resumir o que a vulnerabilidade afeta;
 *   2. orientar detecção defensiva.
 *
 * Nenhuma saída contém corpo de exploit, PoC ou instruções ofensivas.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { CveRecord, EdbRecord, KnowledgeSample } from "./types";
import { mergeCves } from "./cve";

export const UNSAFE_TERMS = [
  "shellcode",
  "reverse shell",
  "msfvenom",
  "\\x90\\x90",
] as const;

export const MIN_SAMPLE_CHARS = 80;
export const MAX_SAMPLE_CHARS = 12_000;

/** Descrições defensivas de CWE usadas para enriquecer as amostras. */
export const CWE_DESCRIPTIONS: Record<string, string> = {
  "CWE-20": "Validação de entrada inadequada: dados não confiáveis chegam ao componente sem checagem suficiente.",
  "CWE-22": "Path traversal: o caminho informado pelo usuário pode escapar do diretório permitido.",
  "CWE-77": "Injeção de comando: entrada não neutralizada pode ser interpretada como comando pelo sistema.",
  "CWE-89": "Injeção de SQL: entrada não neutralizada altera a estrutura de uma consulta ao banco.",
  "CWE-94": "Injeção de código: conteúdo não confiável é interpretado como código ou expressão executável.",
  "CWE-119": "Restrição inadequada de operações em buffer: limites de memória não são respeitados.",
  "CWE-125": "Leitura fora dos limites: o componente lê memória além da região válida.",
  "CWE-193": "Erro de off-by-one: um limite é calculado com diferença de uma unidade, permitindo acesso indevido.",
  "CWE-269": "Gerenciamento impróprio de privilégios: uma operação recebe mais privilégios do que deveria.",
  "CWE-287": "Autenticação imprópria: a identidade do usuário ou serviço não é verificada corretamente.",
  "CWE-294": "Bypass de autenticação por captura e repetição: uma credencial ou resposta válida pode ser reutilizada.",
  "CWE-330": "Uso de valores insuficientemente aleatórios: segredos ou identificadores podem ser previsíveis.",
  "CWE-400": "Consumo não controlado de recursos: entradas maliciosas podem esgotar CPU, memória ou conexões.",
  "CWE-416": "Uso após liberação: memória liberada continua acessível, permitindo corrupção de estado.",
  "CWE-502": "Desserialização de dados não confiáveis: objetos controlados pelo atacante são reconstruídos pelo serviço.",
  "CWE-665": "Inicialização imprópria: estruturas de dados são usadas antes de receberem estado seguro.",
  "CWE-787": "Escrita fora dos limites: o componente grava além da região de memória reservada.",
  "CWE-917": "Neutralização imprópria em expressão: uma linguagem de expressão interpreta entrada não confiável.",
  "CWE-918": "Server-Side Request Forgery: o servidor é induzido a acessar destinos escolhidos pelo atacante.",
  "CWE-506": "Código malicioso embarcado: um artefato de software contém lógica não legítima inserida na cadeia de suprimentos.",
  "CWE-798": "Credenciais embutidas no código: segredos fixos podem ser extraídos do artefato.",
};

const MEMORY_CWES = new Set(["CWE-119", "CWE-125", "CWE-193", "CWE-416", "CWE-787", "CWE-665"]);
const INJECTION_CWES = new Set(["CWE-77", "CWE-89", "CWE-94", "CWE-917"]);
const AUTH_CWES = new Set(["CWE-269", "CWE-287", "CWE-294", "CWE-330", "CWE-798"]);
const NETWORK_CWES = new Set(["CWE-22", "CWE-400", "CWE-918", "CWE-502"]);

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function isUnsafeText(value: string): boolean {
  const lower = value.toLowerCase();
  return UNSAFE_TERMS.some((term) => lower.includes(term));
}

function hasAny(cwes: string[], group: Set<string>): boolean {
  return cwes.some((cwe) => group.has(cwe));
}

function formatCvss(cve: CveRecord): string {
  if (!cve.cvss) return "não informado nos metadados";
  return `CVSS ${cve.cvss.version} ${cve.cvss.score} (${cve.cvss.severity})${
    cve.cvss.vector ? ` vetor ${cve.cvss.vector}` : ""
  }`;
}

function formatProducts(cve: CveRecord): string {
  if (cve.products.length === 0) return "não especificados nos metadados";
  return cve.products
    .map((product) => {
      const versions = product.versions.length > 0 ? ` (${product.versions.join(", ")})` : "";
      return `${product.vendor}/${product.product}${versions}`;
    })
    .join("; ");
}

function cweLabel(cwe: string, descriptions: Record<string, string>): string {
  return `${cwe}: ${descriptions[cwe] ?? "fraqueza de segurança catalogada no CWE."}`;
}

function cweImpact(cwe: string): string {
  if (MEMORY_CWES.has(cwe)) {
    return "pode causar corrupção de memória, indisponibilidade e, em cenários graves, execução não autorizada de código.";
  }
  if (INJECTION_CWES.has(cwe)) {
    return "pode permitir que entrada controlada pelo atacante altere comandos, consultas ou expressões executadas pelo serviço.";
  }
  if (cwe === "CWE-22") {
    return "pode expor arquivos e diretórios fora do escopo público do serviço.";
  }
  if (cwe === "CWE-89") {
    return "pode expor, alterar ou destruir dados armazenados no banco.";
  }
  if (cwe === "CWE-918") {
    return "pode permitir acesso a serviços internos e a endpoints de metadados da nuvem.";
  }
  if (AUTH_CWES.has(cwe)) {
    return "pode permitir elevação de privilégio, personificação de usuários ou acesso não autorizado.";
  }
  if (cwe === "CWE-400") {
    return "pode causar negação de serviço por esgotamento de conexões, memória ou CPU.";
  }
  if (cwe === "CWE-502") {
    return "pode permitir execução de lógica não prevista durante a reconstrução de objetos.";
  }
  if (cwe === "CWE-506") {
    return "compromete a integridade da cadeia de suprimentos e a confiança no artefato distribuído.";
  }
  return "reduz a garantia de segurança do componente e deve ser tratada com atualização e controles compensatórios.";
}

function severityGuidance(severity: string | undefined, score: number | undefined): string {
  const label = (severity ?? (score !== undefined ? scoreSeverity(score) : "NÃO INFORMADA")).toUpperCase();
  if (label === "CRITICAL") {
    return "Prioridade máxima: aplicar correção ou mitigação compensatória imediatamente, confirmar exposição e monitorar tentativas de exploração.";
  }
  if (label === "HIGH") {
    return "Prioridade alta: corrigir em janela curta, reduzir exposição e acompanhar sinais de exploração.";
  }
  if (label === "MEDIUM") {
    return "Prioridade média: incluir no ciclo regular de correção e reforçar validação e monitoramento.";
  }
  if (label === "LOW") {
    return "Prioridade baixa: corrigir no ciclo planejado e manter controles preventivos habituais.";
  }
  return "Sem pontuação CVSS disponível: classifique pelo impacto no negócio e pela exposição do componente.";
}

function scoreSeverity(score: number): string {
  if (score >= 9) return "CRITICAL";
  if (score >= 7) return "HIGH";
  if (score >= 4) return "MEDIUM";
  if (score > 0) return "LOW";
  return "NONE";
}

function explainVector(vector: string): string {
  if (!vector) return "O vetor não foi detalhado nos metadados.";
  const parts = new Map<string, string>();
  for (const token of vector.split("/")) {
    const [key, value] = token.split(":");
    if (key && value) parts.set(key.toUpperCase(), value.toUpperCase());
  }
  const labels: Record<string, Record<string, string>> = {
    AV: { N: "explorável pela rede", A: "explorável a partir de rede adjacente", L: "explorável localmente", P: "exige acesso físico" },
    AC: { L: "baixa complexidade de ataque", H: "alta complexidade de ataque" },
    PR: { N: "sem privilégios", L: "privilégios baixos", H: "privilégios elevados" },
    UI: { N: "sem interação do usuário", R: "exige interação do usuário" },
    S: { U: "escopo inalterado", C: "escopo alterado, podendo atingir outros componentes" },
    C: { N: "sem impacto de confidencialidade", L: "impacto baixo de confidencialidade", H: "impacto alto de confidencialidade" },
    I: { N: "sem impacto de integridade", L: "impacto baixo de integridade", H: "impacto alto de integridade" },
    A: { N: "sem impacto de disponibilidade", L: "impacto baixo de disponibilidade", H: "impacto alto de disponibilidade" },
  };
  const sentences: string[] = [];
  for (const [key, table] of Object.entries(labels)) {
    const value = parts.get(key);
    if (value && table[value]) sentences.push(table[value]);
  }
  return sentences.length > 0 ? sentences.join("; ") + "." : "O vetor não pôde ser interpretado por completo.";
}

function explainCve(cve: CveRecord, descriptions: Record<string, string>): string {
  const cwes = cve.cwes.length > 0 ? cve.cwes.join(", ") : "não classificada em CWE";
  const cause =
    cve.cwes.length > 0
      ? cve.cwes.map((cwe) => cweLabel(cwe, descriptions)).join(" ")
      : "A causa raiz não está detalhada nos metadados públicos.";
  return [
    `${cve.id} é uma vulnerabilidade publicada em ${cve.published || "data não informada"}. ${cve.description}`,
    `Componentes afetados: ${formatProducts(cve)}.`,
    `Classificação CWE: ${cwes}. ${cause}`,
    `Avaliação CVSS: ${formatCvss(cve)}.`,
    severityGuidance(cve.cvss?.severity, cve.cvss?.score),
    "Esta é uma análise defensiva baseada em metadados públicos (NVD/CWE/CVSS). Nenhum código de exploração é fornecido, armazenado ou necessário.",
  ].join("\n\n");
}

function identifyCwe(cve: CveRecord, descriptions: Record<string, string>): string {
  if (cve.cwes.length === 0) {
    return `${cve.id} não possui CWE explícita nos metadados consultados. Recomenda-se tratar a entrada na fronteira do componente, aplicar atualização do fornecedor e monitorar erros de validação.`;
  }
  const items = cve.cwes.map(
    (cwe) => `- ${cweLabel(cwe, descriptions)} Implicação defensiva: ${cweImpact(cwe)}`,
  );
  return [
    `Fraquezas associadas a ${cve.id}:`,
    ...items,
    "A classificação CWE orienta a escolha de controles preventivos, testes de regressão e sinais de detecção. Ela não descreve uma técnica ofensiva.",
  ].join("\n");
}

function evaluateCvss(cve: CveRecord): string {
  if (!cve.cvss) {
    return `${cve.id} não possui pontuação CVSS nos metadados consultados. Sem essa métrica, priorize pela exposição do componente, pelo tipo de dado processado e pela existência de correção do fornecedor. ${severityGuidance(undefined, undefined)}`;
  }
  const { score, severity, vector, version } = cve.cvss;
  return [
    `A pontuação CVSS ${version} de ${cve.id} é ${score.toFixed(1)}, classificada como ${severity}.`,
    `Vetor: ${vector || "não informado"}.`,
    explainVector(vector),
    `Leitura defensiva: ${severityGuidance(severity, score)}`,
    "A pontuação representa o potencial de impacto e explorabilidade; ela deve ser combinada com a exposição real do ativo, controles existentes e criticidade do negócio.",
  ].join("\n\n");
}

function categorySteps(cwes: string[]): string[] {
  const steps: string[] = [];
  if (hasAny(cwes, MEMORY_CWES)) {
    steps.push(
      "Atualize o componente para a versão corrigida e recompile com proteções de memória do sistema operacional; acompanhe quedas e corrupções de processo.",
    );
  }
  if (hasAny(cwes, INJECTION_CWES)) {
    steps.push(
      "Substitua interpretação dinâmica por APIs seguras, valide entradas por allowlist e aplique codificação de saída; restrinja permissões do processo.",
    );
  }
  if (cwes.includes("CWE-22")) {
    steps.push(
      "Canonicalize caminhos, limite o acesso a um diretório base e rejeite sequências de travessia; rode o serviço com o menor privilégio possível.",
    );
  }
  if (cwes.includes("CWE-89")) {
    steps.push(
      "Use consultas parametrizadas, remova concatenação de SQL e aplique o princípio do menor privilégio na conta do banco.",
    );
  }
  if (cwes.includes("CWE-918")) {
    steps.push(
      "Aplique allowlist de destinos de saída, bloqueie acesso a faixas internas e a endpoints de metadados, e segmente a rede.",
    );
  }
  if (hasAny(cwes, AUTH_CWES)) {
    steps.push(
      "Revise autenticação e autorização, exija MFA para contas privilegiadas, invalide sessões antigas e audite mudanças de privilégio.",
    );
  }
  if (cwes.includes("CWE-400")) {
    steps.push(
      "Aplique limites de conexão, taxa, tamanho de requisição e tempo de execução; configure timeouts e proteção contra esgotamento.",
    );
  }
  if (cwes.includes("CWE-502")) {
    steps.push(
      "Evite desserializar dados não confiáveis; quando inevitável, use allowlist de classes, assinatura de dados e isolamento de processo.",
    );
  }
  if (cwes.includes("CWE-506")) {
    steps.push(
      "Verifique hashes e assinaturas de artefatos, fixe versões confiáveis, audite dependências e reconstrua a partir de fontes verificadas.",
    );
  }
  return steps;
}

function mitigationPlan(cve: CveRecord): string {
  const cwes = cve.cwes;
  const specific = cve.mitigation?.trim();
  const steps: string[] = [];
  if (specific) steps.push(specific);
  steps.push(
    `Aplique a atualização ou o patch oficial do fornecedor para ${cve.id} e valide a versão instalada em todos os ambientes.`,
  );
  steps.push(
    "Reduza a exposição: remova o serviço da internet quando não for necessário, restrinja acesso por firewall ou proxy reverso e desative recursos não usados.",
  );
  steps.push(...categorySteps(cwes));
  steps.push(
    "Reforce o monitoramento: colete logs do componente, crie alertas para erros de validação, falhas de autenticação, processos inesperados e picos de recurso.",
  );
  steps.push(
    "Prepare resposta: mantenha backups íntegros, teste restauração, documente a versão afetada e defina critérios de isolamento do ativo.",
  );
  const unique = [...new Set(steps)];
  return [
    `Plano de mitigação defensiva para ${cve.id}:`,
    ...unique.map((step, index) => `${index + 1}. ${step}`),
    "Referências públicas: " + (cve.references.map((reference) => reference.url).slice(0, 4).join(", ") || "não informadas"),
  ].join("\n");
}

function logsourceFor(cwes: string[]): string {
  if (hasAny(cwes, MEMORY_CWES)) return "application";
  if (hasAny(cwes, AUTH_CWES)) return "authentication";
  if (hasAny(cwes, INJECTION_CWES)) return "process_creation";
  if (hasAny(cwes, NETWORK_CWES)) return "webserver";
  return "application";
}

function detectionSignals(cwes: string[]): string {
  const signals: string[] = [];
  if (hasAny(cwes, MEMORY_CWES)) {
    signals.push("quedas repetidas, corrupção de memória, uso anormal de CPU/memória e reinícios inesperados do processo");
  }
  if (hasAny(cwes, INJECTION_CWES)) {
    signals.push("entradas com caracteres de controle ou expressões em parâmetros, erros de validação e processos filhos incomuns");
  }
  if (cwes.includes("CWE-22")) {
    signals.push("sequências de travessia em caminhos, respostas 403/404 anômalas e acesso a arquivos fora do diretório público");
  }
  if (cwes.includes("CWE-89")) {
    signals.push("erros de sintaxe SQL, consultas incomuns e aumento de leitura ou alteração de dados");
  }
  if (cwes.includes("CWE-918")) {
    signals.push("conexões de saída para destinos não autorizados, faixas internas ou endpoints de metadados");
  }
  if (hasAny(cwes, AUTH_CWES)) {
    signals.push("falhas de autenticação em sequência, mudanças de privilégio, sessões reutilizadas e logons fora do padrão");
  }
  if (cwes.includes("CWE-400")) {
    signals.push("aumento abrupto de conexões ou requisições, latência, timeouts e filas de processamento");
  }
  if (signals.length === 0) {
    signals.push("alertas do fornecedor, varreduras de vulnerabilidade, erros de validação e mudanças de configuração não planejadas");
  }
  return signals.join("; ");
}

function detectionRule(cve: CveRecord): string {
  const description = cve.description.slice(0, 140).replace(/["\n\r]/g, " ").trim();
  return [
    "title: Detecção defensiva de exposição a " + cve.id,
    "id: m5-" + cve.id.toLowerCase(),
    "status: experimental",
    "description: " + description,
    "logsource:",
    "  category: " + logsourceFor(cve.cwes),
    "detection:",
    "  selection_cve:",
    '    vulnerability.id: "' + cve.id + '"',
    "  selection_behavior:",
    "    event.outcome: failure",
    "  condition: selection_cve or selection_behavior",
    "falsepositives:",
    "  - Varredura autorizada",
    "  - Teste de segurança agendado",
    "level: " + (cve.cvss?.severity ?? "medium").toLowerCase(),
  ].join("\n");
}

function detectionCve(cve: CveRecord): string {
  return [
    `Detecção defensiva para ${cve.id}`,
    `Sinais observáveis: ${detectionSignals(cve.cwes)}.`,
    "Regra genérica (pseudo-Sigma, baseada em metadados):",
    "```yaml",
    detectionRule(cve),
    "```",
    "Teste de detecção:",
    "- Positivo: um evento de teste com `vulnerability.id` igual ao CVE deve gerar alerta.",
    "- Negativo: eventos rotineiros do mesmo componente, sem o identificador ou sem o comportamento anômalo, não devem gerar alerta.",
    "A regra é um ponto de partida; ajuste o logsource e os limiares ao ambiente antes de ativá-la.",
  ].join("\n");
}

function cveSamples(cve: CveRecord, descriptions: Record<string, string>): KnowledgeSample[] {
  const cweText = cve.cwes.length > 0 ? cve.cwes.join(", ") : "não informada";
  const references =
    cve.references.map((reference) => reference.url).slice(0, 5).join("\n") || "não informadas";
  const baseInput = [
    cve.id,
    cve.description,
    `Produtos: ${formatProducts(cve)}`,
    `CWE: ${cweText}`,
    `CVSS: ${formatCvss(cve)}`,
    `Referências:\n${references}`,
  ].join("\n");
  const meta = {
    source: cve.source || "nvd",
    cve: cve.id,
    cwe: cve.cwes,
    cvss: cve.cvss?.score ?? null,
    severity: cve.cvss?.severity ?? null,
    defensive: true,
  };

  return [
    {
      instruction: `Explique de forma defensiva a vulnerabilidade ${cve.id}, incluindo causa raiz, componentes afetados e impacto potencial. Não produza código de exploração.`,
      input: baseInput,
      output: explainCve(cve, descriptions),
      meta: { ...meta, task: "explain" },
    },
    {
      instruction: `Identifique e classifique as fraquezas (CWE) associadas a ${cve.id} e explique o significado defensivo de cada uma.`,
      input: baseInput,
      output: identifyCwe(cve, descriptions),
      meta: { ...meta, task: "cwe" },
    },
    {
      instruction: `Avalie a pontuação CVSS e a severidade de ${cve.id}, explicando o vetor e o que ele indica sobre explorabilidade e impacto.`,
      input: baseInput,
      output: evaluateCvss(cve),
      meta: { ...meta, task: "cvss" },
    },
    {
      instruction: `Proponha um plano de mitigação defensiva para ${cve.id}, priorizando correção, redução de exposição e monitoramento.`,
      input: baseInput,
      output: mitigationPlan(cve),
      meta: { ...meta, task: "mitigation" },
    },
    {
      instruction: `Escreva uma regra ou teste de detecção genérico e defensivo para ${cve.id}, sem incluir código de exploração.`,
      input: baseInput,
      output: detectionCve(cve),
      meta: { ...meta, task: "detection" },
    },
  ];
}

function edbInput(record: EdbRecord): string {
  return [
    `ExploitDB ${record.id}`,
    record.description,
    `Data: ${record.datePublished || "não informada"}`,
    `Autor: ${record.author || "não informado"}`,
    `Tipo: ${record.type || "não informado"}`,
    `Plataforma: ${record.platform || "não informada"}`,
    `CVEs: ${record.cveCodes.join(", ") || "não associados"}`,
    `Referência: ${record.url}`,
  ].join("\n");
}

function edbSamples(record: EdbRecord): KnowledgeSample[] {
  const cves = record.cveCodes.join(", ") || "não associados a CVE";
  const platform = record.platform || "não informada";
  const meta = {
    source: "exploitdb",
    edb: record.id,
    cve: record.cveCodes,
    platform,
    defensive: true,
  };

  return [
    {
      instruction: `Resuma de forma defensiva o que a vulnerabilidade catalogada no ExploitDB ${record.id} afeta, sem descrever passos de exploração.`,
      input: edbInput(record),
      output: [
        `O registro ${record.id} do índice ExploitDB descreve: ${record.description}`,
        `Plataforma afetada: ${platform}. Tipo de registro: ${record.type || "não informado"}. Data: ${record.datePublished || "não informada"}.`,
        `CVEs associados: ${cves}.`,
        "Leitura defensiva: identifique os ativos que usam essa plataforma, confirme a versão instalada, verifique se há correção do fornecedor e trate o registro apenas como metadado de priorização.",
        `Referência pública: ${record.url}`,
        "Nenhum arquivo ou corpo de exploit é baixado, armazenado ou reproduzido.",
      ].join("\n\n"),
      meta: { ...meta, task: "edb-summary" },
    },
    {
      instruction: `Descreva como detectar e mitigar de forma defensiva atividades relacionadas ao registro ExploitDB ${record.id}.`,
      input: edbInput(record),
      output: [
        `Detecção e mitigação para o cenário ${record.id} (${platform}).`,
        "Sinais de detecção: alertas do fornecedor, varreduras contra o serviço, erros de validação, processos ou conexões fora do padrão e mudanças de configuração não planejadas.",
        "Mitigação: aplique a atualização do fornecedor, remova exposição desnecessária, restrinja acesso por rede, habilite logs detalhados e monitore os ativos afetados.",
        `CVEs para correlação: ${cves}. Referência: ${record.url}`,
        "A orientação é defensiva e baseada apenas em metadados do índice.",
      ].join("\n\n"),
      meta: { ...meta, task: "edb-detection" },
    },
  ];
}

function dedupeAndFilter(samples: KnowledgeSample[]): KnowledgeSample[] {
  const seen = new Set<string>();
  const output: KnowledgeSample[] = [];
  for (const sample of samples) {
    if (!sample.instruction.trim() || !sample.output.trim()) continue;
    const size = sample.instruction.length + sample.input.length + sample.output.length;
    if (size < MIN_SAMPLE_CHARS || size > MAX_SAMPLE_CHARS) continue;
    if (isUnsafeText(JSON.stringify(sample))) continue;
    const key = sha256(`${sample.instruction}\n${sample.input}`);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(sample);
  }
  return output;
}

export interface BuildKnowledgeOptions {
  cves: CveRecord[];
  edb: EdbRecord[];
  cweDescriptions?: Record<string, string>;
}

/**
 * Gera as amostras defensivas. Deduplica CVEs/EDB por id e amostras por
 * sha256(instruction+input), aplicando o filtro de tamanho.
 */
export function buildKnowledgeSamples(options: BuildKnowledgeOptions): KnowledgeSample[] {
  const descriptions = { ...CWE_DESCRIPTIONS, ...(options.cweDescriptions ?? {}) };
  const samples: KnowledgeSample[] = [];

  for (const cve of mergeCves(options.cves)) {
    if (isUnsafeText(`${cve.description} ${cve.mitigation ?? ""}`)) continue;
    samples.push(...cveSamples(cve, descriptions));
  }

  const seenEdb = new Set<string>();
  for (const record of options.edb) {
    if (seenEdb.has(record.id)) continue;
    seenEdb.add(record.id);
    if (isUnsafeText(`${record.description} ${record.type} ${record.platform}`)) continue;
    samples.push(...edbSamples(record));
  }

  return dedupeAndFilter(samples);
}

export interface KnowledgeSplits {
  train: KnowledgeSample[];
  validation: KnowledgeSample[];
  test: KnowledgeSample[];
}

function sampleKey(sample: KnowledgeSample): string {
  return sha256(`${sample.instruction}\n${sample.input}`);
}

/** Divide de forma determinística em ~90/5/5 (mínimo de 1 quando possível). */
export function splitSamples(samples: KnowledgeSample[]): KnowledgeSplits {
  const ordered = [...samples].sort((a, b) => sampleKey(a).localeCompare(sampleKey(b)));
  const total = ordered.length;
  if (total === 0) return { train: [], validation: [], test: [] };

  const minimum = total >= 10 ? 1 : 0;
  const testCount = Math.min(Math.max(Math.floor(total * 0.05), minimum), Math.floor(total / 3));
  const validationCount = Math.min(
    Math.max(Math.floor(total * 0.05), minimum),
    Math.floor((total - testCount) / 2),
  );

  return {
    test: ordered.slice(0, testCount),
    validation: ordered.slice(testCount, testCount + validationCount),
    train: ordered.slice(testCount + validationCount),
  };
}

export interface KnowledgeManifest {
  version: number;
  createdAt: string;
  format: "jsonl";
  defensive: true;
  total: number;
  splits: { train: number; validation: number; test: number };
  ratios: { train: number; validation: number; test: number };
  sources: Record<string, number>;
  sha256: { train: string; validation: string; test: string };
}

function writeJsonl(file: string, samples: KnowledgeSample[]): string {
  const content = samples.map((sample) => JSON.stringify(sample)).join("\n");
  const payload = content ? `${content}\n` : "";
  fs.writeFileSync(file, payload, "utf8");
  return sha256(payload);
}

/** Grava os splits JSONL e o manifest em `outDir`. */
export function writeKnowledgeDataset(
  samples: KnowledgeSample[],
  outDir: string,
): KnowledgeManifest {
  fs.mkdirSync(outDir, { recursive: true });
  const splits = splitSamples(samples);
  const files = {
    train: path.join(outDir, "train.jsonl"),
    validation: path.join(outDir, "validation.jsonl"),
    test: path.join(outDir, "test.jsonl"),
  };
  const hashes = {
    train: writeJsonl(files.train, splits.train),
    validation: writeJsonl(files.validation, splits.validation),
    test: writeJsonl(files.test, splits.test),
  };

  const sources: Record<string, number> = {};
  for (const sample of samples) {
    const source = String(sample.meta?.source ?? "unknown");
    sources[source] = (sources[source] ?? 0) + 1;
  }

  const total = samples.length;
  const manifest: KnowledgeManifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    format: "jsonl",
    defensive: true,
    total,
    splits: {
      train: splits.train.length,
      validation: splits.validation.length,
      test: splits.test.length,
    },
    ratios: {
      train: total ? splits.train.length / total : 0,
      validation: total ? splits.validation.length / total : 0,
      test: total ? splits.test.length / total : 0,
    },
    sources,
    sha256: hashes,
  };

  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    "utf8",
  );
  return manifest;
}

/** Lê o manifest, se existir. */
export function readManifest(outDir: string): KnowledgeManifest | null {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(outDir, "manifest.json"), "utf8"),
    ) as KnowledgeManifest;
    return parsed;
  } catch {
    return null;
  }
}

function countLines(file: string): number {
  try {
    const text = fs.readFileSync(file, "utf8").trim();
    return text ? text.split(/\r?\n/).length : 0;
  } catch {
    return 0;
  }
}

export interface DatasetStats {
  manifest: KnowledgeManifest | null;
  counts: { train: number; validation: number; test: number; total: number };
}

/** Conta amostras por split a partir dos arquivos gerados. */
export function datasetStats(outDir: string): DatasetStats {
  const counts = {
    train: countLines(path.join(outDir, "train.jsonl")),
    validation: countLines(path.join(outDir, "validation.jsonl")),
    test: countLines(path.join(outDir, "test.jsonl")),
    total: 0,
  };
  counts.total = counts.train + counts.validation + counts.test;
  return { manifest: readManifest(outDir), counts };
}
