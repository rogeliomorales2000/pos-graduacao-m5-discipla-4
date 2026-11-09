/**
 * CLI didático do módulo de redes.
 *
 * Uso:
 *   npx tsx apps/agent/src/modules/net/cli.ts subnet 192.168.10.0/24
 *   npx tsx apps/agent/src/modules/net/cli.ts vlsm 192.168.0.0/24 50,20,10,5
 *   npx tsx apps/agent/src/modules/net/cli.ts route 10.1.2.3 10.0.0.0/8 10.1.0.0/16
 *   npx tsx apps/agent/src/modules/net/cli.ts sim single-switch h1 h2
 *   npx tsx apps/agent/src/modules/net/cli.ts labs
 *   npx tsx apps/agent/src/modules/net/cli.ts labs inter-vlan
 */

import process from "node:process";
import { pathToFileURL } from "node:url";
import { Ipv4 } from "./types";
import {
  formatCidr,
  intToIp,
  ipToInt,
  isPrivateIp,
  parseCidr,
  toBinary,
  vlsmAllocate,
} from "./ip";
import { RouteEntry } from "./types";
import { longestPrefixMatch, routeToCidr } from "./l3";
import { SCENARIOS, buildScenario, minTtl, send } from "./simulator";
import { answerLabel, getLab, listLabs } from "./labs";

const USAGE = `M5 Agent — laboratório de redes

Uso:
  subnet <cidr>                 Detalha rede, máscara, broadcast e hosts
  vlsm <cidr> <n1,n2,...>       Plano VLSM para os tamanhos de hosts
  route <ip> <cidr...>          Longest-prefix match entre as rotas
  sim <cenario> <src> <dst>     Simula um pacote e narra cada decisão
  labs                          Lista os laboratórios
  labs <id>                     Mostra um laboratório, passos e quiz

Cenários: ${SCENARIOS.map((item) => item.name).join(", ")}
Laboratórios: ${listLabs().map((item) => item.id).join(", ")}

Exemplos:
  subnet 192.168.10.0/24
  vlsm 192.168.0.0/24 50,20,10,5
  route 10.1.2.3 10.0.0.0/8 10.1.0.0/16 0.0.0.0/0
  sim router-on-a-stick h1 h3
  labs vlans`;

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function subnetCommand(args: string[]): string {
  if (args.length !== 1) throw new Error("uso: subnet <cidr>");
  const cidr = parseCidr(args[0]);
  const lines = [
    `CIDR informado ....: ${cidr.ip}/${cidr.prefix}`,
    `Endereço de rede ..: ${cidr.network}`,
    `Broadcast .........: ${cidr.broadcast}`,
    `Máscara ...........: ${cidr.mask} (/${cidr.prefix})`,
    `Wildcard ..........: ${cidr.wildcard}`,
    `Hosts utilizáveis .: ${cidr.hostCount} de ${cidr.addressCount}`,
    `Faixa de hosts ....: ${cidr.firstHost} - ${cidr.lastHost}`,
    `Binário da máscara : ${toBinary(cidr.mask)}`,
    `Classe/escopo .....: ${isPrivateIp(cidr.ip) ? "privado (RFC 1918)" : "público"}`,
  ];
  if (cidr.prefix === 31) {
    lines.push("Observação ........: /31 usa os dois endereços como hosts (RFC 3021).");
  } else if (cidr.prefix === 32) {
    lines.push("Observação ........: /32 representa um único host.");
  }
  return lines.join("\n");
}

function vlsmCommand(args: string[]): string {
  if (args.length < 2) throw new Error("uso: vlsm <cidr> <n1,n2,...>");
  const base = parseCidr(args[0]);
  const sizes = args
    .slice(1)
    .join(",")
    .split(/[,\s]+/)
    .filter(Boolean)
    .map((value) => {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`Tamanho inválido: ${value}`);
      return parsed;
    });
  const blocks = vlsmAllocate(args[0], sizes);
  const header = [
    `Base: ${base.network}/${base.prefix} (${base.addressCount} endereços, ${base.hostCount} hosts utilizáveis)`,
    "",
    `${pad("#", 3)}${pad("Hosts", 7)}${pad("Prefixo", 9)}${pad("Rede", 18)}${pad("Faixa utilizável", 34)}${pad("Úteis", 7)}Desperdício`,
  ].join("\n");
  const rows = blocks.map((block, index) =>
    `${pad(String(index + 1), 3)}${pad(String(block.request), 7)}${pad(`/${block.prefix}`, 9)}${pad(
      block.network,
      18,
    )}${pad(`${block.firstHost} - ${block.lastHost}`, 34)}${pad(
      String(block.usable),
      7,
    )}${block.wasted}`,
  );
  const lastEnd = Math.max(...blocks.map((block) => ipToInt(block.broadcast)));
  const freeStart = lastEnd + 1;
  const freeEnd = ipToInt(base.broadcast);
  const free =
    freeStart <= freeEnd
      ? `${intToIp(freeStart)} - ${intToIp(freeEnd)} (${freeEnd - freeStart + 1} endereços)`
      : "nenhum";
  return [header, ...rows, "", `Espaço livre após a alocação: ${free}`].join("\n");
}

function routeCommand(args: string[]): string {
  if (args.length < 2) throw new Error("uso: route <ip> <cidr...>");
  const target: Ipv4 = args[0];
  parseCidr(`${target}/32`); // valida o IP
  const cidrs = args
    .slice(1)
    .flatMap((item) => item.split(","))
    .filter(Boolean)
    .map((item) => (item === "default" ? "0.0.0.0/0" : item));

  const routes: RouteEntry[] = cidrs.map((item, index) => {
    const parsed = parseCidr(item);
    return {
      network: parsed.network,
      prefix: parsed.prefix,
      nextHop: null,
      iface: `rota${index + 1}`,
      kind: parsed.prefix === 0 ? "default" : "static",
    };
  });

  const winner = longestPrefixMatch(routes, target);
  const lines = [`Consulta: ${target}`, "", "Candidatas:"];
  for (const route of routes) {
    lines.push(`  ${pad(routeToCidr(route), 20)} prefixo /${route.prefix}`);
  }
  lines.push("");
  if (winner) {
    const cidr = parseCidr(`${winner.network}/${winner.prefix}`);
    lines.push(
      `Vencedora: ${formatCidr(cidr.network, cidr.prefix)} (prefixo /${cidr.prefix})`,
      `Motivo ...: maior prefixo que contém ${target} (longest-prefix match)`,
    );
  } else {
    lines.push(`Nenhuma rota cobre ${target}: o pacote seria descartado.`);
  }
  return lines.join("\n");
}

function simCommand(args: string[]): string {
  if (args.length !== 3) throw new Error("uso: sim <cenario> <src> <dst>");
  const [scenarioName, src, dst] = args;
  const info = SCENARIOS.find((item) => item.name === scenarioName);
  const topology = buildScenario(scenarioName);
  const steps = send(topology, src, dst);
  const lines = [
    `Cenário: ${info ? `${info.title} — ${info.description}` : topology.name}`,
    `Origem: ${src}    Destino: ${dst}`,
    "",
  ];
  for (const step of steps) {
    lines.push(
      `${String(step.index).padStart(3, "0")} [${pad(step.layer, 4)}] ${pad(
        step.device,
        14,
      )} ${step.action}`,
    );
    lines.push(`     -> ${step.decision}`);
    const meta: string[] = [];
    if (step.table) meta.push(`tabela: ${step.table}`);
    if (step.ttl !== undefined) meta.push(`TTL: ${step.ttl}`);
    if (step.detail) meta.push(step.detail);
    if (meta.length > 0) lines.push(`        ${meta.join(" | ")}`);
    if (step.ok === false) lines.push("        (descarte/erro)");
  }
  const ttl = minTtl(steps);
  lines.push(
    "",
    `Resumo: ${steps.length} passo(s); ${
      steps.some((step) => step.ok === false) ? "houve descarte" : "pacote entregue"
    }; menor TTL observado: ${ttl ?? "n/a"}`,
  );
  return lines.join("\n");
}

function topologySummary(topology: ReturnType<typeof buildScenario>): string {
  const lines = [
    `Hosts: ${topology.hosts.map((item) => `${item.name}(${item.ip}${item.vlan ? ` vlan${item.vlan}` : ""})`).join(", ") || "nenhum"}`,
    `Switches: ${topology.switches.map((item) => item.name).join(", ") || "nenhum"}`,
    `Roteadores: ${topology.routers.map((item) => item.name).join(", ") || "nenhum"}`,
    `Links: ${topology.links.length}`,
  ];
  if (topology.vlanNames) {
    lines.push(
      `VLANs: ${Object.entries(topology.vlanNames)
        .map(([id, name]) => `${id}=${name}`)
        .join(", ")}`,
    );
  }
  return lines.join("\n");
}

function labsCommand(args: string[]): string {
  if (args.length === 0) {
    const lines = ["Laboratórios disponíveis:"];
    for (const lab of listLabs()) {
      lines.push("", `${pad(lab.id, 16)} ${lab.title}`, `  Objetivo: ${lab.objective}`);
    }
    lines.push("", "Detalhe com: labs <id>");
    return lines.join("\n");
  }
  if (args.length !== 1) throw new Error("uso: labs [id]");
  const lab = getLab(args[0]);
  if (!lab) throw new Error(`Laboratório desconhecido: ${args[0]}`);
  const lines = [
    lab.title,
    "",
    `Objetivo: ${lab.objective}`,
    "",
    "Topologia:",
    lab.topology ? topologySummary(lab.topology) : "  (laboratório de cálculo, sem topologia)",
    "",
    "Passos esperados:",
    ...lab.expectedSteps.map((step, index) => `  ${index + 1}. ${step}`),
    "",
    "Comandos:",
    ...lab.commands.map((command) => `  net ${command}`),
    "",
    "Dicas:",
    ...lab.hints.map((hint) => `  - ${hint}`),
    "",
    "Quiz:",
  ];
  lab.quiz.forEach((question, index) => {
    lines.push("", `  ${index + 1}. ${question.question}`);
    question.options.forEach((option, optionIndex) => {
      lines.push(`     ${String.fromCharCode(65 + optionIndex)}) ${option}`);
    });
    lines.push(`     Resposta: ${answerLabel(question)} — ${question.explanation}`);
  });
  return lines.join("\n");
}

/** Executa um comando e devolve o texto (sem imprimir). */
export function runCommand(args: string[]): string {
  if (args.length === 0) return USAGE;
  const [command, ...rest] = args;
  switch (command) {
    case "help":
    case "--help":
    case "-h":
      return USAGE;
    case "subnet":
      return subnetCommand(rest);
    case "vlsm":
      return vlsmCommand(rest);
    case "route":
      return routeCommand(rest);
    case "sim":
      return simCommand(rest);
    case "labs":
      return labsCommand(rest);
    default:
      throw new Error(`Comando desconhecido: ${command}\n\n${USAGE}`);
  }
}

export function main(argv = process.argv.slice(2)): number {
  try {
    const output = runCommand(argv);
    if (output) process.stdout.write(`${output}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`erro: ${message}\n`);
    return 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  process.exitCode = main();
}
