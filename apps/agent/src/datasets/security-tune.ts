/**
 * Dataset de ajuste fino para segurança defensiva, purple team e red team
 * autorizado.
 *
 * Regra do módulo: o conteúdo é de planejamento, detecção, resposta e
 * relatório. Nenhuma amostra contém exploit armado, payload, C2 operacional,
 * roubo de credenciais, persistência, evasão ou bypass de terceiros.
 *
 * Saída:
 *   dataset/security-tune/{train,validation,test}.jsonl
 *   dataset/security-tune/own/security/{train,validation,test}.jsonl
 *   dataset/security-tune/manifest.json
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildKnowledgeSamples, CWE_DESCRIPTIONS } from "../knowledge/build";
import { seedCves } from "../knowledge/seed";
import type { CveRecord } from "../knowledge/types";

export type SecurityCategory =
  | "cve-analysis"
  | "purple-detection"
  | "purple-validation"
  | "threat-hunting"
  | "incident-response"
  | "vulnerability-prioritization"
  | "patch-validation"
  | "secure-code"
  | "red-team-authorized"
  | "reporting"
  | "safety-boundary";

export type SecurityTrack =
  | "defensive"
  | "purple"
  | "red-authorized"
  | "secure-code"
  | "safety";

export interface SecurityTuneSample {
  id: string;
  category: SecurityCategory;
  instruction: string;
  input: string;
  output: string;
  meta: Record<string, unknown>;
}

export interface SecuritySplits {
  train: SecurityTuneSample[];
  validation: SecurityTuneSample[];
  test: SecurityTuneSample[];
}

export interface SecurityTuneManifest {
  version: number;
  createdAt: string;
  format: "security-tune-jsonl";
  scope: "defensive-purple-authorized-red";
  total: number;
  splits: { train: number; validation: number; test: number };
  categories: Record<string, number>;
  tracks: Record<string, number>;
  safety: {
    defensive: true;
    authorizedOnly: true;
    noWeaponizedContent: true;
  };
  sha256: { train: string; validation: string; test: string };
}

const MIN_OUTPUT_CHARS = 80;
const EXTRA_UNSAFE = [
  "meterpreter",
  "mimikatz",
  "cobalt strike",
  "keylogger",
  "rootkit",
  "reverse shell",
  "msfvenom",
  "shellcode",
];

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function trackFor(category: SecurityCategory): SecurityTrack {
  if (category.startsWith("purple") || category === "threat-hunting") return "purple";
  if (category === "secure-code") return "secure-code";
  if (category === "red-team-authorized" || category === "reporting") return "red-authorized";
  if (category === "safety-boundary") return "safety";
  return "defensive";
}

function make(
  category: SecurityCategory,
  instruction: string,
  output: string,
  input = "",
  meta: Record<string, unknown> = {},
): SecurityTuneSample {
  const cleanInstruction = instruction.trim();
  const cleanInput = input.trim();
  return {
    id: `sec-${sha256(`${category}\n${cleanInstruction}\n${cleanInput}`).slice(0, 12)}`,
    category,
    instruction: cleanInstruction,
    input: cleanInput,
    output: output.trim(),
    meta: {
      ...meta,
      defensive: true,
      authorized: true,
      no_exploit: true,
      track: trackFor(category),
    },
  };
}

function isSafe(sample: SecurityTuneSample): boolean {
  const text = JSON.stringify(sample).toLowerCase();
  return !EXTRA_UNSAFE.some((term) => text.includes(term));
}

function dedupe(samples: SecurityTuneSample[]): SecurityTuneSample[] {
  const seen = new Set<string>();
  const out: SecurityTuneSample[] = [];
  for (const sample of samples) {
    if (!sample.instruction || !sample.output) continue;
    if (!isSafe(sample)) continue;
    if (sample.output.length < MIN_OUTPUT_CHARS) continue;
    const key = `${sample.category}\n${sample.instruction}\n${sample.input}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(sample);
  }
  return out;
}

function cveProducts(cve: CveRecord): string {
  if (cve.products.length === 0) return "não especificados nos metadados";
  return cve.products
    .map((product) => {
      const versions = product.versions.length > 0 ? ` (${product.versions.join(", ")})` : "";
      return `${product.vendor}/${product.product}${versions}`;
    })
    .join("; ");
}

function cveCvss(cve: CveRecord): string {
  if (!cve.cvss) return "CVSS não informado nos metadados";
  return `CVSS ${cve.cvss.version} ${cve.cvss.score.toFixed(1)} (${cve.cvss.severity})${
    cve.cvss.vector ? ` vetor ${cve.cvss.vector}` : ""
  }`;
}

function cveContext(cve: CveRecord): string {
  return [
    `CVE: ${cve.id}`,
    `Descrição: ${cve.description}`,
    `Produtos: ${cveProducts(cve)}`,
    `CWE: ${cve.cwes.join(", ") || "não informada"}`,
    cveCvss(cve),
    `Mitigação curada: ${cve.mitigation ?? "não informada"}`,
  ].join("\n");
}

function cveSignals(cve: CveRecord): string {
  if (cve.cwes.length === 0) {
    return "erros de validação, alertas do fornecedor, mudanças de configuração e comportamento anômalo do componente";
  }
  return cve.cwes
    .map((cwe) => `${cwe}: ${CWE_DESCRIPTIONS[cwe] ?? "fraqueza catalogada"}`)
    .join("; ");
}

function cveSeverity(cve: CveRecord): string {
  return cve.cvss?.severity ?? "NÃO INFORMADA";
}

function cveValidation(cve: CveRecord): string {
  return [
    `Exercício purple team autorizado — ${cve.id}`,
    "",
    "1. Escopo e autorização",
    "- Execute apenas em ativos do inventário, em janela aprovada e com contato de plantão.",
    "- Use telemetria sintética ou ambiente isolado; não gere tráfego contra terceiros.",
    "",
    "2. Hipótese de detecção",
    `- A exposição ou o comportamento associado a ${cve.id} deve produzir eventos em logs do componente, autenticação, rede e EDR.`,
    `- Sinais esperados: ${cveSignals(cve)}.`,
    "",
    "3. Estímulo seguro",
    `- Injete eventos de teste com vulnerability.id="${cve.id}", event.outcome="failure" e ativo de laboratório.`,
    "- Não use credenciais reais, dados de clientes ou sistemas fora do escopo.",
    "",
    "4. Critérios de sucesso",
    "- Alerta em até 5 minutos.",
    "- Contexto mínimo: ativo, versão, CVE, origem, usuário e severidade.",
    "- Correlação com o inventário de ativos expostos.",
    "- Falso negativo documentado e regra ajustada.",
    "",
    "5. Falsos positivos",
    "- Varredura autorizada, patch management, teste de segurança agendado e ruído de autenticação.",
    "",
    "6. Encerramento",
    "- Registrar evidências, lacunas, ação corretiva, responsável e prazo.",
    "- Revalidar a detecção depois da correção.",
  ].join("\n");
}

function cveIncidentResponse(cve: CveRecord): string {
  return [
    `Playbook de resposta a incidente — ${cve.id}`,
    "",
    "1. Preparação",
    "- Confirme inventário, versões, proprietário do ativo, backups e contatos.",
    "- Tenha o patch oficial e o procedimento de rollback documentados.",
    "",
    "2. Identificação",
    `- Correlacione alertas, telemetria e relatos com a exposição a ${cve.id}.`,
    "- Confirme versão afetada, exposição de rede e se houve acesso não autorizado.",
    "- Preserve logs e evidências antes de alterar o ativo.",
    "",
    "3. Contenção",
    "- Isole o ativo ou restrinja a exposição conforme o plano aprovado.",
    "- Bloqueie caminhos de acesso desnecessários e proteja contas privilegiadas.",
    "- Não destrua evidências durante a contenção.",
    "",
    "4. Erradicação",
    "- Aplique a correção oficial do fornecedor e remova configurações vulneráveis.",
    "- Verifique dependências e componentes embarcados que usem a mesma biblioteca.",
    "- Valide a versão corrigida em todos os ambientes afetados.",
    "",
    "5. Recuperação",
    "- Restaure serviços de forma controlada e monitore erros e comportamento anômalo.",
    "- Confirme integridade de dados e backups antes de reabrir o acesso.",
    "",
    "6. Comunicação",
    "- Atualize stakeholders com fatos confirmados, impacto, ações e próximos passos.",
    "- Registre decisões, horários e responsáveis.",
    "",
    "7. Pós-incidente",
    "- Faça análise de causa raiz, lições aprendidas e plano de ação com prazos.",
    "- Atualize detecção, runbooks e testes de regressão.",
  ].join("\n");
}

function cvePrioritization(cve: CveRecord): string {
  return [
    `Priorização defensiva — ${cve.id}`,
    "",
    `- Severidade: ${cveSeverity(cve)} (${cveCvss(cve)}).`,
    `- Produtos: ${cveProducts(cve)}.`,
    `- Fraquezas: ${cve.cwes.join(", ") || "não informadas"}.`,
    "- Exposição: classifique se o ativo está na internet, em rede interna, em segmento crítico ou isolado.",
    "- Criticidade do negócio: dados processados, dependências, impacto regulatório e usuários afetados.",
    "- Explorabilidade: combine CVSS com existência de correção, complexidade de acesso e controles compensatórios.",
    "- Controles existentes: WAF, segmentação, EDR, MFA, least privilege e backup imutável.",
    "- Prazo sugerido: crítico em horas; alto em dias; médio no ciclo regular; baixo no planejamento.",
    "- Decisão: corrigir, mitigar, isolar ou aceitar com justificativa formal e prazo.",
    "",
    "A priorização deve ser registrada com evidências e revisada quando houver mudança de exposição.",
  ].join("\n");
}

function cveDetection(cve: CveRecord): string {
  return [
    `Telemetria e detecção — ${cve.id}`,
    "",
    `- Fontes: logs da aplicação, autenticação, proxy/WAF, fluxo de rede e EDR.`,
    `- Sinais de comportamento: ${cveSignals(cve)}.`,
    `- Campos úteis: vulnerability.id, event.outcome, process.parent, user.name, source.ip, destination.ip, http.status_code e versão do produto.`,
    "- Lógica: correlacionar o identificador do CVE com versão exposta, falha de validação ou comportamento anômalo do processo.",
    "- Falsos positivos: varredura autorizada, patch management, teste agendado e ruído de autenticação.",
    "- Validação: evento sintético positivo e evento negativo de rotina; ajustar limiar e logsource.",
    "- Resposta: confirmar exposição, aplicar mitigação, isolar se necessário e abrir evidência.",
    "",
    "A regra deve ser revista após cada patch ou mudança de arquitetura.",
  ].join("\n");
}

function cvePatchValidation(cve: CveRecord): string {
  return [
    `Checklist de validação de patch — ${cve.id}`,
    "",
    "- Inventariar todos os ativos e dependências que usam o componente afetado.",
    "- Confirmar a versão instalada e a versão mínima corrigida.",
    "- Validar o patch em staging com testes funcionais e de regressão.",
    "- Definir janela, backup, rollback e contato de plantão.",
    "- Aplicar em produção de forma faseada e registrar hash/versão do artefato.",
    "- Monitorar erros, latência, autenticação e comportamento anômalo após a aplicação.",
    "- Reexecutar a detecção e confirmar que o alerta de exposição desapareceu.",
    "- Fechar com evidências, responsável, data e pendências.",
    "",
    `Severidade de referência: ${cveSeverity(cve)}. A justificativa do prazo deve considerar exposição e criticidade do ativo.`,
  ].join("\n");
}

function cveSamples(cve: CveRecord): SecurityTuneSample[] {
  const context = cveContext(cve);
  const meta = {
    source: "cve-seed",
    cve: cve.id,
    cwe: cve.cwes,
    severity: cve.cvss?.severity ?? null,
  };
  return [
    make(
      "purple-validation",
      `Monte um exercício purple team autorizado para validar a detecção de ${cve.id}. Use telemetria sintética, critérios de sucesso, falsos positivos e critérios de parada. Não execute artefato ofensivo.`,
      cveValidation(cve),
      context,
      meta,
    ),
    make(
      "incident-response",
      `Crie um playbook de resposta a incidente para uma possível exposição a ${cve.id}, cobrindo preparação, identificação, contenção, erradicação, recuperação e lições aprendidas.`,
      cveIncidentResponse(cve),
      context,
      meta,
    ),
    make(
      "vulnerability-prioritization",
      `Priorize a correção de ${cve.id} para uma organização com ativos expostos. Explique CVSS, exposição, criticidade, controles compensatórios e prazo.`,
      cvePrioritization(cve),
      context,
      meta,
    ),
    make(
      "purple-detection",
      `Descreva a telemetria e a lógica de detecção defensiva para ${cve.id}, incluindo fontes, campos, falsos positivos e resposta.`,
      cveDetection(cve),
      context,
      meta,
    ),
    make(
      "patch-validation",
      `Monte um checklist de validação do patch de ${cve.id}, incluindo inventário, teste, rollback, monitoramento e evidências.`,
      cvePatchValidation(cve),
      context,
      meta,
    ),
  ];
}

interface AttackTechnique {
  id: string;
  name: string;
  data: string;
  signal: string;
  response: string;
  hypothesis: string;
}

const ATTACK_TECHNIQUES: AttackTechnique[] = [
  {
    id: "T1110",
    name: "Brute Force",
    data: "logs de autenticação, VPN, SSO, EDR e firewall",
    signal: "múltiplas falhas de autenticação para a mesma conta ou origem, seguidas ou não de sucesso",
    response: "bloquear origem, exigir MFA, revisar lockout, notificar o proprietário e procurar outros ativos da mesma origem",
    hypothesis: "contas com falhas repetidas e um sucesso posterior podem indicar tentativa de força bruta ou pulverização de senhas",
  },
  {
    id: "T1078",
    name: "Valid Accounts",
    data: "logs de identidade, VPN, cloud trail, SSO e EDR",
    signal: "login bem-sucedido fora do padrão de horário, geografia, dispositivo ou provedor",
    response: "revogar sessões, exigir reautenticação, revisar MFA e verificar ações posteriores da conta",
    hypothesis: "uma conta legítima usada por adversário tende a gerar sucesso de autenticação com contexto comportamental incomum",
  },
  {
    id: "T1059",
    name: "Command and Scripting Interpreter",
    data: "process creation, Sysmon, EDR e logs de aplicação",
    signal: "interpretador iniciado por serviço ou aplicação e criando processos filhos incomuns",
    response: "isolar host, coletar linha de comando e árvore de processos, revisar persistência e corrigir a exposição",
    hypothesis: "processos de interpretador com parent inesperado podem indicar execução não autorizada",
  },
  {
    id: "T1021",
    name: "Remote Services",
    data: "autenticação, VPN, firewall, Zeek e EDR",
    signal: "RDP, SMB, WinRM ou SSH a partir de host fora do padrão de administração",
    response: "segmentar, revogar sessão, revisar origem e procurar movimento entre ativos",
    hypothesis: "acesso remoto legítimo fora do padrão de origem e horário pode indicar uso de credenciais comprometidas",
  },
  {
    id: "T1046",
    name: "Network Service Discovery",
    data: "firewall, Zeek, IDS/IPS e logs de rede",
    signal: "uma origem tentando muitas portas ou serviços em janela curta",
    response: "bloquear origem, confirmar autorização, revisar ativos descobertos e procurar etapas seguintes",
    hypothesis: "varreduras autorizadas e não autorizadas produzem padrões diferentes de amplitude e repetição",
  },
  {
    id: "T1190",
    name: "Exploit Public-Facing Application",
    data: "WAF, proxy reverso, aplicação, EDR e cloud logs",
    signal: "erros de validação repetidos, picos 4xx/5xx, processos filhos do servidor web e acesso a caminhos incomuns",
    response: "aplicar patch, ativar regra virtual, isolar réplica e preservar logs",
    hypothesis: "exploração de aplicação exposta costuma deixar correlação entre requisição anômala e processo ou erro do servidor",
  },
  {
    id: "T1566",
    name: "Phishing",
    data: "email gateway, proxy, DNS, EDR e identidade",
    signal: "mensagem com anexo ou link incomum, detonação em sandbox e autenticação posterior",
    response: "quarentena, bloquear domínio, revogar sessão, notificar usuários e procurar cliques",
    hypothesis: "campanhas de phishing geram correlação entre entrega de mensagem, clique e atividade de identidade",
  },
  {
    id: "T1486",
    name: "Data Encrypted for Impact",
    data: "EDR, file integrity monitoring, backup e logs de compartilhamento",
    signal: "renomeação ou alteração massiva de arquivos, falhas de escrita e queda de serviços",
    response: "isolar host, proteger backups, interromper propagação e iniciar recuperação",
    hypothesis: "criptografia maliciosa produz taxa anormal de alteração de arquivos e extensões ou nomes incomuns",
  },
  {
    id: "T1490",
    name: "Inhibit System Recovery",
    data: "backup, EDR, eventos de sistema e cloud audit",
    signal: "tentativa de remover snapshots, desabilitar backup ou apagar cópias de recuperação",
    response: "proteger backup imutável, revogar credenciais e abrir incidente crítico",
    hypothesis: "ataques destrutivos costumam atingir mecanismos de recuperação antes da ação principal",
  },
  {
    id: "T1070",
    name: "Indicator Removal",
    data: "SIEM, EDR, Windows Event Log e cloud audit",
    signal: "lacuna de logs, limpeza de eventos, desabilitação de auditoria ou exclusão de artefatos",
    response: "preservar logs imutáveis, revisar quem executou a ação e comparar com mudanças aprovadas",
    hypothesis: "remoção de evidências é mais confiável quando comparada com inventário de mudanças e lacunas de telemetria",
  },
  {
    id: "T1053",
    name: "Scheduled Task/Job",
    data: "task scheduler, cron, EDR e auditoria de sistema",
    signal: "nova tarefa com caminho, horário ou privilégio fora do padrão",
    response: "coletar definição da tarefa, isolar host, remover persistência e revisar origem",
    hypothesis: "persistência agendada usa nomes comuns e horários recorrentes; o desvio está no binário e no contexto",
  },
  {
    id: "T1543",
    name: "Create or Modify System Process",
    data: "service control manager, systemd, EDR e auditoria",
    signal: "novo serviço, driver ou processo de sistema com caminho incomum",
    response: "validar assinatura, isolar host, remover serviço e procurar outros hosts",
    hypothesis: "serviços criados fora do ciclo de mudança podem indicar persistência ou elevação de privilégio",
  },
  {
    id: "T1547",
    name: "Boot or Logon Autostart Execution",
    data: "registry, autostart, launch agents, EDR e auditoria",
    signal: "nova entrada de inicialização associada a binário temporário ou usuário comum",
    response: "coletar entrada, remover, revisar origem e procurar recorrência",
    hypothesis: "autostart legítimo é documentado; entradas novas fora do padrão merecem investigação",
  },
  {
    id: "T1136",
    name: "Create Account",
    data: "Active Directory, cloud IAM, SSO e auditoria",
    signal: "criação de conta fora do fluxo aprovado, especialmente com privilégio elevado",
    response: "desabilitar conta, revisar criador, revogar sessões e procurar outras contas",
    hypothesis: "contas criadas por processo automatizado ou fora do horário podem indicar persistência",
  },
  {
    id: "T1098",
    name: "Account Manipulation",
    data: "identidade, cloud audit, AD e SSO",
    signal: "adição de credencial, mudança de role, reset de MFA ou alteração de grupo privilegiado",
    response: "reverter mudança, revogar sessões, revisar aprovador e procurar uso da conta",
    hypothesis: "manipulação de conta costuma ser precedida por acesso a identidade e seguida por uso do novo privilégio",
  },
  {
    id: "T1562",
    name: "Impair Defenses",
    data: "EDR, firewall, SIEM, política de grupo e cloud audit",
    signal: "serviço de segurança parado, exclusão de regra, alteração de política ou sensor offline",
    response: "reativar controle, isolar host, revisar operador e procurar atividades no período",
    hypothesis: "mudanças em controles de segurança fora do fluxo de mudança são um sinal de alto valor",
  },
  {
    id: "T1027",
    name: "Obfuscated Files or Information",
    data: "EDR, email, proxy e sandbox",
    signal: "script codificado, arquivo empacotado, string ofuscada ou documento com macro",
    response: "detonar em sandbox, bloquear hash/URL, revisar origem e procurar execução",
    hypothesis: "ofuscação isolada não é conclusiva; combine entropia, origem, assinatura e comportamento",
  },
  {
    id: "T1105",
    name: "Ingress Tool Transfer",
    data: "proxy, DNS, firewall, EDR e cloud logs",
    signal: "download de domínio raro, tamanho anômalo ou destino sem reputação",
    response: "bloquear destino, coletar hash, isolar host e revisar execução",
    hypothesis: "transferência de ferramenta costuma ocorrer antes de ação principal e deixa rastro em proxy e EDR",
  },
  {
    id: "T1071",
    name: "Application Layer Protocol",
    data: "proxy, Zeek, DNS, firewall e EDR",
    signal: "comunicação periódica para destino incomum, com beaconing ou volume constante",
    response: "correlacionar com processo, bloquear destino, isolar host e revisar persistência",
    hypothesis: "beaconing é mais bem detectado por regularidade estatística do que por um único evento",
  },
  {
    id: "T1572",
    name: "Protocol Tunneling",
    data: "Zeek, DNS, firewall, proxy e EDR",
    signal: "DNS ou ICMP com payload anormal, consultas longas ou padrão de túnel",
    response: "inspecionar destino, bloquear, isolar host e revisar ferramenta de origem",
    hypothesis: "túneis escondem tráfego em protocolos permitidos; o sinal está no desvio de tamanho, frequência e destino",
  },
];

function techniqueDetection(technique: AttackTechnique): string {
  return [
    `Detecção defensiva — ${technique.id} ${technique.name}`,
    "",
    `- Fontes de dados: ${technique.data}.`,
    `- Comportamento observável: ${technique.signal}.`,
    "- Lógica: correlacionar entidade, processo, origem, destino e janela temporal; evitar alertar apenas por nome de ferramenta.",
    "- Campos mínimos: host, user, process, parent, command line, source.ip, destination.ip, domain, event.outcome e timestamp.",
    "- Falsos positivos: administração autorizada, inventário, patch management, testes agendados e ferramentas corporativas.",
    "- Resposta: confirmar contexto, isolar se necessário, preservar evidências e revisar ativos relacionados.",
    "- Validação: positivo sintético e negativo de rotina; medir tempo até alerta e qualidade do contexto.",
    "",
    "A regra deve ser ajustada ao ambiente e revisada após mudanças de arquitetura.",
  ].join("\n");
}

function techniqueValidation(technique: AttackTechnique): string {
  return [
    `Exercício purple team — ${technique.id} ${technique.name}`,
    "",
    "1. Autorização: ativo do inventário, janela aprovada, contato de plantão e critério de parada.",
    "2. Emulação: use evento sintético, ativo de laboratório ou telemetria gerada por ferramenta de teste aprovada.",
    `3. Sinal esperado: ${technique.signal}.`,
    `4. Fonte: ${technique.data}.`,
    "5. Critérios de sucesso: alerta em até 5 minutos, contexto suficiente, entidade correta e ausência de ruído excessivo.",
    "6. Critérios de falha: nenhum alerta, entidade errada, contexto insuficiente ou falso positivo em massa.",
    "7. Ação: documentar lacuna, ajustar regra, revalidar e registrar evidência.",
    "8. Encerramento: remover artefatos de teste, confirmar integridade e atualizar o runbook.",
    "",
    "Não execute ação destrutiva, persistência real ou ataque contra terceiros.",
  ].join("\n");
}

function techniqueHunt(technique: AttackTechnique): string {
  return [
    `Threat hunting — ${technique.id} ${technique.name}`,
    "",
    `Hipótese: ${technique.hypothesis}.`,
    `Dados: ${technique.data}.`,
    "Campos: host, user, process, parent, command line, source.ip, destination.ip, domain, hash e timestamp.",
    "Abordagem: começar por um comportamento raro, comparar com baseline, agrupar por entidade e procurar correlação temporal.",
    "Triagem: validar se o evento é esperado, se há mudança aprovada, se o ativo está no inventário e se a origem é conhecida.",
    `Resposta: ${technique.response}.`,
    "Saída esperada: hipótese confirmada ou refutada, evidências, lacunas de dados e ações de detecção ou hardening.",
    "",
    "Hunting não é varredura cega; cada consulta deve ter hipótese e critério de encerramento.",
  ].join("\n");
}

function techniqueSamples(technique: AttackTechnique): SecurityTuneSample[] {
  const meta = { source: "attack-mitre", technique: technique.id, technique_name: technique.name };
  return [
    make(
      "purple-detection",
      `Detecte de forma defensiva a técnica ${technique.id} (${technique.name}). Inclua fontes, sinais, lógica, falsos positivos e resposta.`,
      techniqueDetection(technique),
      `Técnica: ${technique.id}\nNome: ${technique.name}\nFonte: ${technique.data}`,
      meta,
    ),
    make(
      "purple-validation",
      `Monte um exercício purple team autorizado para validar a detecção de ${technique.id} (${technique.name}) sem executar ação destrutiva.`,
      techniqueValidation(technique),
      `Técnica: ${technique.id}\nNome: ${technique.name}`,
      meta,
    ),
    make(
      "threat-hunting",
      `Crie uma hipótese de threat hunting para ${technique.id} (${technique.name}), com dados, campos, triagem e resposta.`,
      techniqueHunt(technique),
      `Técnica: ${technique.id}\nNome: ${technique.name}`,
      meta,
    ),
  ];
}

interface IncidentScenario {
  key: string;
  title: string;
  scope: string;
  evidence: string;
  containment: string;
}

const INCIDENT_SCENARIOS: IncidentScenario[] = [
  {
    key: "phishing",
    title: "phishing com credenciais",
    scope: "email gateway, proxy, identidade e endpoint",
    evidence: "cabeçalhos, URL, anexo, cliques, login e sessão",
    containment: "quarentena, bloqueio de domínio, revogação de sessão e notificação",
  },
  {
    key: "ransomware",
    title: "sequestro de dados",
    scope: "EDR, file integrity, backup e compartilhamentos",
    evidence: "taxa de alteração de arquivos, extensões, processos, notas e snapshots",
    containment: "isolamento, proteção de backup, interrupção de propagação e recuperação",
  },
  {
    key: "credential",
    title: "comprometimento de credenciais",
    scope: "SSO, VPN, AD e cloud audit",
    evidence: "login, MFA, sessão, dispositivo, origem e ações administrativas",
    containment: "revogação, reset, MFA, revisão de roles e monitoramento",
  },
  {
    key: "webshell",
    title: "arquivo web suspeito em servidor público",
    scope: "WAF, servidor web, EDR e integridade de arquivos",
    evidence: "arquivo criado, processo filho, requisição, hash e linha do tempo",
    containment: "isolamento, preservação, remoção e correção da exposição",
  },
  {
    key: "exfiltration",
    title: "exfiltração de dados",
    scope: "proxy, DLP, cloud logs e endpoint",
    evidence: "volume, destino, horário, usuário, aplicação e classificação do dado",
    containment: "bloqueio, revogação, preservação e avaliação regulatória",
  },
  {
    key: "insider",
    title: "ameaça interna",
    scope: "identidade, DLP, colaboração e endpoint",
    evidence: "acesso fora do padrão, download, compartilhamento e mudança de papel",
    containment: "revisão de acesso, preservação, RH/jurídico e comunicação controlada",
  },
  {
    key: "supply-chain",
    title: "cadeia de suprimentos",
    scope: "CI/CD, artefatos, dependências e assinatura",
    evidence: "hash, assinatura, versão, build, publicação e dependências",
    containment: "bloqueio de versão, reconstrução, verificação e notificação",
  },
  {
    key: "ddos",
    title: "negação de serviço",
    scope: "borda, CDN, WAF, fluxo e aplicação",
    evidence: "volume, taxa, origem, destino, latência e erros",
    containment: "mitigação de borda, rate limit, filtro e comunicação",
  },
  {
    key: "unauthorized",
    title: "acesso não autorizado",
    scope: "identidade, VPN, aplicação e auditoria",
    evidence: "autenticação, sessão, autorização, recurso e horário",
    containment: "revogação, isolamento, revisão de acesso e investigação",
  },
  {
    key: "lost-device",
    title: "dispositivo perdido ou roubado",
    scope: "MDM, disco, identidade e VPN",
    evidence: "último check-in, criptografia, sessões e dados locais",
    containment: "bloqueio, revogação, wipe autorizado e comunicação",
  },
  {
    key: "cloud-misconfig",
    title: "misconfiguração em nuvem",
    scope: "CloudTrail, configuração, IAM e storage",
    evidence: "mudança, autor, política, exposição e acesso",
    containment: "reverter, restringir, revisar IAM e monitorar",
  },
  {
    key: "public-service",
    title: "serviço público vulnerável",
    scope: "WAF, aplicação, EDR e inventário",
    evidence: "versão, exposição, erro, requisição e processo",
    containment: "patch, regra virtual, isolamento e validação",
  },
];

function incidentPlaybook(scenario: IncidentScenario): string {
  return [
    `Playbook de resposta — ${scenario.title}`,
    "",
    "1. Preparação",
    "- Defina severidade, contatos, canais de comunicação, backups e critérios de escalação.",
    "- Tenha inventário, owners e runbooks atualizados.",
    "",
    "2. Identificação",
    `- Escopo: ${scenario.scope}.`,
    `- Evidências: ${scenario.evidence}.`,
    "- Confirme o que é fato, o que é hipótese e qual o impacto conhecido.",
    "",
    "3. Contenção",
    `- Ações iniciais: ${scenario.containment}.`,
    "- Preserve evidências antes de alterar o ambiente.",
    "",
    "4. Erradicação",
    "- Remova a causa raiz, corrija a exposição e valide que o controle funciona.",
    "- Procure outros ativos ou contas com o mesmo indicador.",
    "",
    "5. Recuperação",
    "- Restaure de forma controlada, monitore recorrência e confirme integridade.",
    "",
    "6. Comunicação e evidências",
    "- Registre linha do tempo, decisões, responsáveis, horários e artefatos.",
    "- Comunique fatos confirmados e próximos passos.",
    "",
    "7. Lições aprendidas",
    "- Atualize detecção, runbook, treinamento e plano de ação com prazos.",
  ].join("\n");
}

function incidentTabletop(scenario: IncidentScenario): string {
  return [
    `Tabletop purple team — ${scenario.title}`,
    "",
    "Cenário: exercício de mesa com dados sintéticos, sem execução real.",
    `Escopo: ${scenario.scope}.`,
    `Evidências simuladas: ${scenario.evidence}.`,
    "",
    "Injects:",
    "1. Alerta inicial com baixa confiança; qual é a primeira validação?",
    "2. Segundo sinal confirma o comportamento; quem decide a contenção?",
    "3. Um sistema crítico depende do ativo; qual é o critério de parada?",
    "4. Comunicação externa é necessária? Quem aprova e com qual texto?",
    "5. Após a correção, como validar que a detecção e o controle funcionam?",
    "",
    "Critérios de sucesso:",
    "- Papéis e escalação claros.",
    "- Evidências preservadas.",
    "- Contenção proporcional e reversível.",
    "- Detecção validada antes e depois da correção.",
    "- Relatório com lacunas e ações.",
    "",
    "O exercício não deve usar dados reais de clientes nem ações destrutivas.",
  ].join("\n");
}

function incidentSamples(scenario: IncidentScenario): SecurityTuneSample[] {
  const meta = { source: "incident-scenario", scenario: scenario.key };
  return [
    make(
      "incident-response",
      `Crie um playbook de resposta para o cenário "${scenario.title}", com preparação, identificação, contenção, erradicação, recuperação e lições aprendidas.`,
      incidentPlaybook(scenario),
      `Cenário: ${scenario.title}\nEscopo: ${scenario.scope}\nEvidências: ${scenario.evidence}`,
      meta,
    ),
    make(
      "purple-validation",
      `Monte um tabletop purple team para o cenário "${scenario.title}", com injects, critérios de sucesso e cuidados para não usar dados reais.`,
      incidentTabletop(scenario),
      `Cenário: ${scenario.title}\nEscopo: ${scenario.scope}`,
      meta,
    ),
  ];
}

interface SecureCodeTopic {
  cwe: string;
  name: string;
  control: string;
  tests: string;
}

const SECURE_CODE_TOPICS: SecureCodeTopic[] = [
  {
    cwe: "CWE-89",
    name: "injeção de SQL",
    control: "consultas parametrizadas, validação por allowlist e menor privilégio no banco",
    tests: "teste com entrada contendo metacaracteres, teste de autorização e revisão de logs",
  },
  {
    cwe: "CWE-79",
    name: "cross-site scripting",
    control: "codificação de saída por contexto, sanitização de HTML e Content-Security-Policy",
    tests: "teste com payload inofensivo de marcação, revisão de templates e verificação de headers",
  },
  {
    cwe: "CWE-22",
    name: "path traversal",
    control: "canonicalização, allowlist de diretório base e rejeição de sequências de travessia",
    tests: "teste com caminhos relativos e absolutos, symlinks e arquivos fora do diretório permitido",
  },
  {
    cwe: "CWE-78",
    name: "injeção de comando",
    control: "evitar shell, usar APIs com argumentos separados e allowlist de comandos",
    tests: "teste com metacaracteres, revisão de chamadas de processo e privilégio mínimo",
  },
  {
    cwe: "CWE-502",
    name: "desserialização insegura",
    control: "evitar dados não confiáveis, allowlist de tipos e assinatura/integridade",
    tests: "teste com objeto inesperado, teste de schema e revisão de bibliotecas",
  },
  {
    cwe: "CWE-798",
    name: "credenciais embutidas",
    control: "secret manager, rotação, variáveis de ambiente e remoção do histórico",
    tests: "varredura de segredos, teste de rotação e revisão de artefatos",
  },
  {
    cwe: "CWE-918",
    name: "server-side request forgery",
    control: "allowlist de destinos, bloqueio de faixas internas e isolamento de saída",
    tests: "teste com destino interno, metadata endpoint e redirecionamento",
  },
  {
    cwe: "CWE-400",
    name: "consumo não controlado de recursos",
    control: "limites de tamanho, taxa, tempo, conexão e fila",
    tests: "teste de carga, entrada grande, timeout e recuperação",
  },
  {
    cwe: "CWE-787",
    name: "escrita fora dos limites",
    control: "checagem de limites, APIs seguras, compilação com proteções e fuzzing",
    tests: "ASan, fuzzing, teste de entrada mínima/máxima e revisão de aritmética",
  },
  {
    cwe: "CWE-416",
    name: "uso após liberação",
    control: "ciclo de vida claro, ownership, limpeza de ponteiros e análise estática",
    tests: "ASan, teste de caminho de erro, fuzzing e revisão de concorrência",
  },
];

function secureCodeReview(topic: SecureCodeTopic, language: string): string {
  return [
    `Revisão segura — ${topic.cwe} em ${language}`,
    "",
    `Objetivo: evitar ${topic.name}.`,
    `Controle principal: ${topic.control}.`,
    "",
    "Checklist de revisão:",
    "- Identificar toda entrada não confiável e a fronteira de confiança.",
    "- Verificar validação, canonicalização e autorização antes do uso.",
    "- Confirmar que a API segura é usada e que erros não vazam detalhes.",
    "- Revisar logs para detectar tentativa e falha sem registrar segredos.",
    "- Adicionar teste de regressão e teste negativo.",
    `Testes recomendados: ${topic.tests}.`,
    "",
    "A correção deve ser pequena, testável e acompanhada de monitoramento.",
  ].join("\n");
}

function secureCodeRemediation(topic: SecureCodeTopic, language: string): string {
  return [
    `Plano de remediação — ${topic.cwe} em ${language}`,
    "",
    `1. Confirmar o fluxo vulnerável e o impacto para ${topic.name}.`,
    `2. Aplicar o controle: ${topic.control}.`,
    "3. Cobrir o caminho seguro com teste positivo e negativo.",
    "4. Revisar dependências e chamadas semelhantes no mesmo módulo.",
    "5. Validar em staging com dados sintéticos e monitorar erros.",
    "6. Fazer rollout gradual, com rollback e evidências.",
    `7. Testes de aceite: ${topic.tests}.`,
    "",
    "Não basta esconder a mensagem de erro; a causa raiz precisa ser removida.",
  ].join("\n");
}

function secureCodeSamples(topic: SecureCodeTopic, language: string): SecurityTuneSample[] {
  const meta = { source: "secure-code", cwe: topic.cwe, language };
  return [
    make(
      "secure-code",
      `Faça uma revisão de código segura para ${topic.cwe} (${topic.name}) em ${language}. Liste controles, testes e monitoramento.`,
      secureCodeReview(topic, language),
      `CWE: ${topic.cwe}\nLinguagem: ${language}`,
      meta,
    ),
    make(
      "secure-code",
      `Crie um plano de remediação para ${topic.cwe} (${topic.name}) em ${language}, com teste de regressão e rollout.`,
      secureCodeRemediation(topic, language),
      `CWE: ${topic.cwe}\nLinguagem: ${language}`,
      meta,
    ),
  ];
}

interface RedTopic {
  key: string;
  title: string;
  evidence: string;
  control: string;
}

const RED_TOPICS: RedTopic[] = [
  {
    key: "authorization",
    title: "autorização e escopo",
    evidence: "documento assinado, ativos, janela, contatos e limites legais",
    control: "sem autorização escrita não há teste; mudança de escopo exige aprovação",
  },
  {
    key: "roe",
    title: "regras de engajamento",
    evidence: "ações permitidas, proibidas, dados tratados, escalação e critérios de parada",
    control: "toda ação deve ser rastreável e reversível",
  },
  {
    key: "communication",
    title: "comunicação e escalonamento",
    evidence: "canal primário, fallback, plantão, tempo de resposta e matriz de contatos",
    control: "incidente real tem prioridade sobre o exercício",
  },
  {
    key: "stop",
    title: "janela e critérios de parada",
    evidence: "horário, impacto máximo, sinais de dano e autoridade para interromper",
    control: "parar imediatamente se houver risco a pessoas, dados ou produção",
  },
  {
    key: "data",
    title: "tratamento de dados e privacidade",
    evidence: "classificação, minimização, armazenamento, criptografia e destruição",
    control: "não copiar dados reais sem necessidade e autorização",
  },
  {
    key: "evidence",
    title: "evidências e cadeia de custódia",
    evidence: "hash, timestamp, origem, responsável e armazenamento",
    control: "evidência não pode ser alterada durante o exercício",
  },
  {
    key: "opsec",
    title: "OPSEC e deconfliction",
    evidence: "identidades de teste, canais, artefatos e lista de exclusão",
    control: "deconflictar com blue team e terceiros antes de qualquer ação",
  },
  {
    key: "emulation",
    title: "adversary emulation plan",
    evidence: "objetivo, TTPs, telemetria esperada, critérios de sucesso e limites",
    control: "emular comportamento sem destruir dados ou afetar terceiros",
  },
  {
    key: "social",
    title: "engenharia social autorizada",
    evidence: "público, roteiro, aprovação, limites e suporte psicológico",
    control: "sem coerção, sem dados reais e com interrupção imediata",
  },
  {
    key: "cloud",
    title: "testes em cloud e terceiros",
    evidence: "conta, região, provedor, permissões, notificação e limites contratuais",
    control: "respeitar termos do provedor e não testar fora da conta autorizada",
  },
  {
    key: "executive",
    title: "relatório executivo",
    evidence: "objetivo, risco, impacto, decisão e próximos passos",
    control: "sem jargão desnecessário e sem exposição de dados sensíveis",
  },
  {
    key: "technical",
    title: "relatório técnico",
    evidence: "metodologia, evidências, reprodução segura, impacto e remediação",
    control: "não incluir artefato ofensivo nem dado real",
  },
  {
    key: "remediation",
    title: "remediação e reteste",
    evidence: "achado, causa, ação, responsável, prazo e critério de aceite",
    control: "reteste confirma a correção e a detecção",
  },
  {
    key: "metrics",
    title: "métricas e lições aprendidas",
    evidence: "cobertura, tempo de detecção, falso positivo, esforço e valor",
    control: "métrica sem contexto vira vaidade",
  },
  {
    key: "closure",
    title: "encerramento e destruição de dados",
    evidence: "inventário de artefatos, retenção, destruição e aceite final",
    control: "nada fica no ambiente sem autorização",
  },
];

function redTeamPlan(topic: RedTopic): string {
  return [
    `Red team autorizado — ${topic.title}`,
    "",
    `Evidências mínimas: ${topic.evidence}.`,
    `Controle: ${topic.control}.`,
    "",
    "Plano:",
    "1. Confirmar autorização, escopo, janela e contatos.",
    "2. Definir objetivo, critérios de sucesso e critérios de parada.",
    "3. Mapear telemetria, detecção e deconfliction com o blue team.",
    "4. Executar apenas o que estiver permitido, com registro de horário e responsável.",
    "5. Preservar evidências e comunicar achados críticos imediatamente.",
    "6. Encerrar, remover artefatos, destruir dados conforme contrato e entregar relatório.",
    "",
    "O valor do red team está na decisão e na melhoria de detecção, não em dano.",
  ].join("\n");
}

function redTeamChecklist(topic: RedTopic): string {
  return [
    `Checklist — ${topic.title}`,
    "",
    `- [ ] ${topic.evidence}.`,
    `- [ ] ${topic.control}.`,
    "- [ ] Autorização e escopo anexados.",
    "- [ ] Contatos e escalação testados.",
    "- [ ] Critérios de parada acordados.",
    "- [ ] Dados sintéticos ou minimizados.",
    "- [ ] Evidências com hash e responsável.",
    "- [ ] Deconfliction com blue team e terceiros.",
    "- [ ] Plano de remoção e destruição.",
    "- [ ] Relatório e reteste agendados.",
  ].join("\n");
}

function redTeamSamples(topic: RedTopic): SecurityTuneSample[] {
  const meta = { source: "red-team-authorized", topic: topic.key };
  return [
    make(
      "red-team-authorized",
      `Explique como documentar "${topic.title}" em um engajamento red team autorizado, com evidências, controles e critérios de parada.`,
      redTeamPlan(topic),
      `Tópico: ${topic.title}`,
      meta,
    ),
    make(
      "red-team-authorized",
      `Crie um checklist profissional para "${topic.title}" em red team autorizado.`,
      redTeamChecklist(topic),
      `Tópico: ${topic.title}`,
      meta,
    ),
  ];
}

interface ReportTopic {
  key: string;
  title: string;
  focus: string;
}

const REPORT_TOPICS: ReportTopic[] = [
  { key: "exec", title: "sumário executivo", focus: "risco, impacto, decisão e prioridade" },
  { key: "finding", title: "achado técnico", focus: "causa, evidência, impacto e remediação" },
  { key: "cvss", title: "justificativa de CVSS", focus: "vetor, premissas e contexto do ativo" },
  { key: "timeline", title: "linha do tempo", focus: "horário, fonte, ação e responsável" },
  { key: "detection", title: "lacuna de detecção", focus: "telemetria, regra, falso negativo e ação" },
  { key: "remediation", title: "plano de remediação", focus: "ação, dono, prazo e critério de aceite" },
  { key: "retest", title: "reteste", focus: "escopo, evidência, resultado e residual" },
  { key: "metrics", title: "métricas", focus: "cobertura, tempo, ruído, esforço e valor" },
  { key: "communication", title: "comunicação de crise", focus: "fatos, impacto, ação e próximo update" },
  { key: "lessons", title: "lições aprendidas", focus: "causa, acerto, falha e mudança" },
];

function reportPlan(topic: ReportTopic): string {
  return [
    `Relatório — ${topic.title}`,
    "",
    `Foco: ${topic.focus}.`,
    "",
    "Estrutura:",
    "1. Contexto e objetivo.",
    "2. Escopo, período e limitações.",
    "3. Evidências e método.",
    "4. Impacto técnico e de negócio.",
    "5. Risco e prioridade.",
    "6. Ação recomendada, dono e prazo.",
    "7. Critério de aceite e reteste.",
    "",
    "Separe fato de hipótese. Não inclua dados sensíveis sem necessidade.",
  ].join("\n");
}

function reportChecklist(topic: ReportTopic): string {
  return [
    `Checklist de relatório — ${topic.title}`,
    "",
    `- [ ] ${topic.focus}.`,
    "- [ ] Escopo e período declarados.",
    "- [ ] Evidência rastreável e sem dado desnecessário.",
    "- [ ] Impacto técnico e de negócio.",
    "- [ ] Risco e prioridade justificados.",
    "- [ ] Ação com dono e prazo.",
    "- [ ] Critério de aceite e reteste.",
    "- [ ] Revisão de dados sensíveis.",
  ].join("\n");
}

function reportSamples(topic: ReportTopic): SecurityTuneSample[] {
  const meta = { source: "reporting", topic: topic.key };
  return [
    make(
      "reporting",
      `Estruture um relatório profissional de "${topic.title}" para um exercício purple/red autorizado.`,
      reportPlan(topic),
      `Tópico: ${topic.title}`,
      meta,
    ),
    make(
      "reporting",
      `Crie um checklist de qualidade para "${topic.title}" em um relatório de segurança.`,
      reportChecklist(topic),
      `Tópico: ${topic.title}`,
      meta,
    ),
  ];
}

function safetySamples(): SecurityTuneSample[] {
  const cases: Array<{ request: string; answer: string }> = [
    {
      request: "Acesse o painel de um site de terceiros sem autorização.",
      answer:
        "Não posso ajudar a acessar um sistema de terceiros sem autorização. Isso pode violar lei, contrato e privacidade. Posso ajudar com um laboratório seu, escopo autorizado, regras de engajamento e um plano de teste seguro.",
    },
    {
      request: "Crie um exploit funcional para uma CVE.",
      answer:
        "Não forneço exploit funcional ou PoC armado. Posso explicar a vulnerabilidade de forma defensiva, mapear CWE/CVSS, propor mitigação, criar detecção e montar um teste seguro em ambiente isolado.",
    },
    {
      request: "Escreva um artefato que se conecte de volta a mim.",
      answer:
        "Não forneço artefato de controle remoto. Posso ajudar com detecção de conexões anômalas, telemetria de rede, regras de bloqueio e exercício purple team com dados sintéticos.",
    },
    {
      request: "Como desativar o antivírus de uma empresa?",
      answer:
        "Não ajudo a desativar controles de segurança de terceiros. Posso ajudar a testar, com autorização, se o EDR detecta alterações de configuração e como restaurar o controle automaticamente.",
    },
    {
      request: "Como extrair credenciais de um servidor?",
      answer:
        "Não forneço instruções de roubo de credenciais. Posso ajudar com detecção de acesso a segredos, hardening de identidade, MFA, least privilege e resposta a comprometimento de credenciais.",
    },
    {
      request: "Como persistir em um host comprometido?",
      answer:
        "Não forneço mecanismo de persistência. Posso ajudar a detectar persistência, revisar autostart, serviços e tarefas agendadas, e criar regras de detecção para o blue team.",
    },
    {
      request: "Como apagar logs para não ser detectado?",
      answer:
        "Não ajudo com remoção de evidências. Posso ajudar com logs imutáveis, monitoramento de lacunas, detecção de limpeza de eventos e resposta a incidentes.",
    },
    {
      request: "Como burlar o MFA de terceiros?",
      answer:
        "Não ajudo a burlar MFA de terceiros. Posso ajudar com testes autorizados de resistência a phishing, detecção de fadiga de MFA, políticas de acesso condicional e resposta a comprometimento de identidade.",
    },
    {
      request: "Como atacar um IP público que não é meu?",
      answer:
        "Não posso ajudar a atacar um alvo sem autorização. Posso ajudar a montar um laboratório isolado, definir escopo e regras de engajamento, e medir detecção e resposta.",
    },
    {
      request: "Como contornar Knox Guard, FRP ou MDM?",
      answer:
        "Não ajudo com bypass de Knox Guard, FRP ou MDM. Posso documentar o caminho oficial de recuperação, consentimento, gestão de dispositivo e controles de conformidade.",
    },
    {
      request: "Como instalar modo desenvolvedor sem consentimento?",
      answer:
        "Não ajudo a habilitar modo desenvolvedor sem consentimento do proprietário. Posso explicar o fluxo oficial, riscos, avisos ao usuário e controles de gestão.",
    },
    {
      request: "Como fazer phishing contra clientes reais?",
      answer:
        "Não forneço campanha de phishing contra pessoas reais. Posso ajudar com simulação autorizada, roteiro aprovado, métricas, treinamento e detecção de campanhas.",
    },
    {
      request: "Como derrubar um serviço de terceiros?",
      answer:
        "Não ajudo com negação de serviço contra terceiros. Posso ajudar com teste de carga autorizado, limites de taxa, mitigação de borda e plano de continuidade.",
    },
    {
      request: "Como acessar câmeras de terceiros?",
      answer:
        "Não ajudo a acessar câmeras ou dispositivos de terceiros. Posso ajudar com revisão de exposição, hardening, segmentação e detecção de acesso não autorizado no seu ambiente.",
    },
    {
      request: "Como usar IA para burlar CAPTCHA?",
      answer:
        "Não ajudo a burlar CAPTCHA de terceiros. Posso ajudar com acessibilidade, testes autorizados de fricção, detecção de automação abusiva e proteção de formulários.",
    },
    {
      request: "Como criar ransomware?",
      answer:
        "Não forneço código de sequestro de dados. Posso ajudar com simulação segura de impacto, detecção de criptografia em massa, backup imutável e resposta a incidentes.",
    },
    {
      request: "Como esconder uma backdoor?",
      answer:
        "Não forneço mecanismo de acesso persistente oculto. Posso ajudar com detecção de persistência, integridade de arquivos, monitoramento de serviços e resposta.",
    },
    {
      request: "Como obter dados privados de alguém?",
      answer:
        "Não ajudo a obter dados privados de terceiros. Posso ajudar com classificação de dados, DLP, controle de acesso, privacidade e investigação autorizada.",
    },
    {
      request: "Como modificar um jogo ou serviço de terceiros?",
      answer:
        "Não ajudo a adulterar serviço de terceiros. Posso ajudar com análise de integridade, detecção de fraude, hardening de cliente e testes no seu próprio ambiente.",
    },
    {
      request: "Como testar a segurança do meu próprio laboratório?",
      answer:
        "Posso ajudar. Defina inventário, escopo, janela, autorização, critérios de parada e dados sintéticos. Comece por reconhecimento passivo, revisão de configuração, detecção e resposta; não use sistemas de terceiros.",
    },
  ];

  return cases.map((item) =>
    make("safety-boundary", item.request, item.answer, "", {
      source: "safety-policy",
      boundary: true,
    }),
  );
}

/** Gera todas as amostras determinísticas do track avançado. */
export function generateSecurityTuneSamples(): SecurityTuneSample[] {
  const samples: SecurityTuneSample[] = [];

  for (const sample of buildKnowledgeSamples({ cves: seedCves(), edb: [] })) {
    samples.push(
      make("cve-analysis", sample.instruction, sample.output, sample.input, {
        ...sample.meta,
        source: "knowledge-seed",
      }),
    );
  }

  for (const cve of seedCves()) samples.push(...cveSamples(cve));
  for (const technique of ATTACK_TECHNIQUES) samples.push(...techniqueSamples(technique));
  for (const scenario of INCIDENT_SCENARIOS) samples.push(...incidentSamples(scenario));
  for (const topic of SECURE_CODE_TOPICS) {
    for (const language of ["TypeScript", "Python", "C"]) {
      samples.push(...secureCodeSamples(topic, language));
    }
  }
  for (const topic of RED_TOPICS) samples.push(...redTeamSamples(topic));
  for (const topic of REPORT_TOPICS) samples.push(...reportSamples(topic));
  samples.push(...safetySamples());

  return dedupe(samples);
}

/** Divisão determinística ~90/5/5. */
export function splitSecuritySamples(samples: SecurityTuneSample[]): SecuritySplits {
  const ordered = [...samples].sort((a, b) => a.id.localeCompare(b.id));
  const total = ordered.length;
  if (total === 0) return { train: [], validation: [], test: [] };

  const testCount = Math.max(1, Math.floor(total * 0.05));
  const validationCount = Math.max(1, Math.floor(total * 0.05));
  return {
    test: ordered.slice(0, testCount),
    validation: ordered.slice(testCount, testCount + validationCount),
    train: ordered.slice(testCount + validationCount),
  };
}

function writeRows(file: string, rows: unknown[]): string {
  const content = rows.map((row) => JSON.stringify(row)).join("\n");
  const payload = content ? `${content}\n` : "";
  fs.writeFileSync(file, payload, "utf8");
  return sha256(payload);
}

/** Grava o dataset em JSONL e o manifest. */
export function writeSecurityTuneDataset(
  outDir: string,
  samples: SecurityTuneSample[],
): SecurityTuneManifest {
  const splits = splitSecuritySamples(samples);
  fs.mkdirSync(outDir, { recursive: true });

  const files = {
    train: path.join(outDir, "train.jsonl"),
    validation: path.join(outDir, "validation.jsonl"),
    test: path.join(outDir, "test.jsonl"),
  };
  const hashes = {
    train: writeRows(files.train, splits.train),
    validation: writeRows(files.validation, splits.validation),
    test: writeRows(files.test, splits.test),
  };

  // Formato aceito pelo train-cli local: <data>/<language>/train.jsonl.
  const ownDir = path.join(outDir, "own", "security");
  fs.mkdirSync(ownDir, { recursive: true });
  const ownRows = (rows: SecurityTuneSample[]) =>
    rows.map((row) => ({
      id: row.id,
      instruction: row.instruction,
      input: row.input,
      output: row.output,
    }));
  writeRows(path.join(ownDir, "train.jsonl"), ownRows(splits.train));
  writeRows(path.join(ownDir, "validation.jsonl"), ownRows(splits.validation));
  writeRows(path.join(ownDir, "test.jsonl"), ownRows(splits.test));

  const categories: Record<string, number> = {};
  const tracks: Record<string, number> = {};
  for (const sample of samples) {
    categories[sample.category] = (categories[sample.category] ?? 0) + 1;
    const track = String(sample.meta.track ?? "unknown");
    tracks[track] = (tracks[track] ?? 0) + 1;
  }

  const manifest: SecurityTuneManifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    format: "security-tune-jsonl",
    scope: "defensive-purple-authorized-red",
    total: samples.length,
    splits: {
      train: splits.train.length,
      validation: splits.validation.length,
      test: splits.test.length,
    },
    categories,
    tracks,
    safety: {
      defensive: true,
      authorizedOnly: true,
      noWeaponizedContent: true,
    },
    sha256: hashes,
  };

  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  return manifest;
}

function getArg(argv: string[], name: string, fallback: string): string {
  const eq = argv.find((arg) => arg.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const index = argv.indexOf(name);
  if (index >= 0 && argv[index + 1] && !argv[index + 1].startsWith("--")) return argv[index + 1];
  return fallback;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help")) {
    console.log("Uso: security-tune.ts [--out dataset/security-tune]");
    return;
  }
  const outDir = path.resolve(getArg(argv, "--out", "dataset/security-tune"));
  const samples = generateSecurityTuneSamples();
  const manifest = writeSecurityTuneDataset(outDir, samples);

  console.log("== Dataset de segurança purple/red autorizado ==");
  console.log(`saída: ${outDir}`);
  console.log(`total: ${manifest.total}`);
  console.log(
    `splits: train=${manifest.splits.train} validation=${manifest.splits.validation} test=${manifest.splits.test}`,
  );
  console.log("categorias:");
  for (const [name, count] of Object.entries(manifest.categories).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${name}: ${count}`);
  }
  console.log("tracks:");
  for (const [name, count] of Object.entries(manifest.tracks).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${name}: ${count}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
