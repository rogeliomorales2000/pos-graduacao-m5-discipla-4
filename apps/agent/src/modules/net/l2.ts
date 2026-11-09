/**
 * Camada 2: switch Ethernet com aprendizado de MAC, flooding, aging,
 * VLANs (access/trunk) e uma visão simplificada de STP.
 *
 * O switch é representado pelo tipo `Switch` (types.ts) e as funções
 * abaixo operam diretamente sobre ele, sem esconder estado: a tabela MAC
 * fica visível para os laboratórios e para o simulador.
 */

import {
  EthernetFrame,
  Link,
  Mac,
  MacTableEntry,
  Switch,
  SwitchPort,
  TraceStep,
} from "./types";

export const MAC_BROADCAST = "ff:ff:ff:ff:ff:ff";
export const DEFAULT_MAC_AGING_MS = 300_000;
export const DEFAULT_VLAN = 1;

/** Normaliza MAC para minúsculas com dois-pontos. Aceita "-" e formato Cisco. */
export function normalizeMac(input: Mac): Mac {
  const raw = input.trim().toLowerCase();
  let expanded = raw.replace(/-/g, ":");
  if (!expanded.includes(":") && expanded.includes(".")) {
    const parts = expanded.split(".");
    if (parts.length === 3 && parts.every((part) => /^[0-9a-f]{4}$/.test(part))) {
      expanded = parts.join("");
      expanded = expanded.match(/.{2}/g)!.join(":");
    }
  }
  if (!/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/.test(expanded)) {
    throw new Error(`MAC inválido: ${input}`);
  }
  return expanded;
}

export function isValidMac(input: string): boolean {
  try {
    normalizeMac(input);
    return true;
  } catch {
    return false;
  }
}

export function isBroadcastMac(mac: Mac): boolean {
  return normalizeMac(mac) === MAC_BROADCAST;
}

/** MAC de grupo (bit 0 do primeiro octeto). */
export function isMulticastMac(mac: Mac): boolean {
  const first = Number.parseInt(normalizeMac(mac).slice(0, 2), 16);
  return (first & 0x01) === 1;
}

export function macToHex(mac: Mac): string {
  return normalizeMac(mac).replace(/:/g, "");
}

export interface BridgeId {
  priority: number;
  mac: Mac;
}

/** Aceita "32768.aa:bb:cc:dd:ee:ff", "32768/aa:bb:..." ou só o MAC. */
export function parseBridgeId(input: string): BridgeId {
  const text = input.trim();
  const match = /^(\d{1,5})\s*[./]\s*(.+)$/.exec(text);
  if (match) {
    const priority = Number(match[1]);
    if (priority > 65535) throw new Error(`Prioridade de bridge inválida: ${priority}`);
    return { priority, mac: normalizeMac(match[2]) };
  }
  return { priority: 32768, mac: normalizeMac(text) };
}

export function formatBridgeId(id: BridgeId): string {
  return `${id.priority}.${id.mac}`;
}

/** Compara bridge IDs: menor prioridade vence; empate vai para o menor MAC. */
export function compareBridgeId(a: string, b: string): number {
  const left = parseBridgeId(a);
  const right = parseBridgeId(b);
  if (left.priority !== right.priority) return left.priority - right.priority;
  const l = macToHex(left.mac);
  const r = macToHex(right.mac);
  return l < r ? -1 : l > r ? 1 : 0;
}

export interface RootElection {
  root: string;
  bridgeId: string;
  ranking: Array<{ name: string; bridgeId: string }>;
}

/** Eleição de root bridge: vence o menor bridge ID (prioridade + MAC). */
export function electRootBridge(switches: Switch[]): RootElection {
  if (switches.length === 0) throw new Error("Nenhum switch para eleger root bridge");
  const ranking = [...switches]
    .map((item) => ({ name: item.name, bridgeId: formatBridgeId(parseBridgeId(item.bridgeId)) }))
    .sort((a, b) => compareBridgeId(a.bridgeId, b.bridgeId));
  return { root: ranking[0].name, bridgeId: ranking[0].bridgeId, ranking };
}

export interface StpRole {
  name: string;
  bridgeId: string;
  root: boolean;
  /** Porta que leva ao root (null no próprio root). */
  rootPort: number | null;
  /** Custo acumulado até o root. */
  cost: number;
  /** Portas redundantes bloqueadas nesta visão simplificada. */
  blockedPorts: number[];
}

export interface StpResult {
  root: string;
  rootBridgeId: string;
  roles: StpRole[];
}

function portOf(sw: Switch, id: number | string): SwitchPort | undefined {
  return sw.ports.find((port) => port.id === id);
}

function switchLinkEndpoints(
  links: Link[],
  switches: Map<string, Switch>,
): Array<{ a: string; aPort: number; b: string; bPort: number }> {
  const result: Array<{ a: string; aPort: number; b: string; bPort: number }> = [];
  for (const link of links) {
    const aSwitch = switches.get(link.a.device);
    const bSwitch = switches.get(link.b.device);
    if (!aSwitch || !bSwitch) continue;
    if (typeof link.a.port !== "number" || typeof link.b.port !== "number") continue;
    result.push({
      a: link.a.device,
      aPort: link.a.port,
      b: link.b.device,
      bPort: link.b.port,
    });
  }
  return result;
}

/**
 * Árvore geradora simplificada: Dijkstra a partir do root (custo das
 * portas, padrão 1) e bloqueio das portas que sobram em enlaces redundantes.
 */
export function spanningTree(switches: Switch[], links: Link[]): StpResult {
  const election = electRootBridge(switches);
  const byName = new Map(switches.map((item) => [item.name, item]));
  const edges = switchLinkEndpoints(links, byName);
  const adjacency = new Map<string, Array<{ to: string; myPort: number; cost: number }>>();
  for (const sw of switches) adjacency.set(sw.name, []);
  for (const edge of edges) {
    const aSw = byName.get(edge.a)!;
    const bSw = byName.get(edge.b)!;
    const aCost = portOf(aSw, edge.aPort)?.cost ?? 1;
    const bCost = portOf(bSw, edge.bPort)?.cost ?? 1;
    adjacency.get(edge.a)!.push({ to: edge.b, myPort: edge.aPort, cost: aCost });
    adjacency.get(edge.b)!.push({ to: edge.a, myPort: edge.bPort, cost: bCost });
  }

  const cost = new Map<string, number>();
  const rootPort = new Map<string, number | null>();
  for (const sw of switches) {
    cost.set(sw.name, Number.POSITIVE_INFINITY);
    rootPort.set(sw.name, null);
  }
  cost.set(election.root, 0);
  const visited = new Set<string>();
  while (visited.size < switches.length) {
    let current: string | null = null;
    let best = Number.POSITIVE_INFINITY;
    for (const sw of switches) {
      if (!visited.has(sw.name) && cost.get(sw.name)! < best) {
        best = cost.get(sw.name)!;
        current = sw.name;
      }
    }
    if (current === null) break;
    visited.add(current);
    for (const link of adjacency.get(current) ?? []) {
      if (visited.has(link.to)) continue;
      const candidate = cost.get(current)! + link.cost;
      if (candidate < cost.get(link.to)!) {
        cost.set(link.to, candidate);
        rootPort.set(link.to, link.myPort);
      }
    }
  }

  // Refaz a marcação de arestas-pai a partir dos root ports eleitos.
  const parentByChild = new Map<string, number>();
  for (const [name, port] of rootPort) {
    if (port !== null) parentByChild.set(name, port);
  }
  const blocked = new Map<string, number[]>();
  for (const sw of switches) blocked.set(sw.name, []);
  for (const edge of edges) {
    const aIsParent = parentByChild.get(edge.a) === edge.aPort;
    const bIsParent = parentByChild.get(edge.b) === edge.bPort;
    if (aIsParent || bIsParent) continue;
    // Porta redundante: bloqueia no lado mais distante do root.
    const aCost = cost.get(edge.a)!;
    const bCost = cost.get(edge.b)!;
    const blockOnA = aCost > bCost || (aCost === bCost && compareBridgeId(byName.get(edge.a)!.bridgeId, byName.get(edge.b)!.bridgeId) > 0);
    if (blockOnA) blocked.get(edge.a)!.push(edge.aPort);
    else blocked.get(edge.b)!.push(edge.bPort);
  }

  const roles: StpRole[] = switches.map((sw) => ({
    name: sw.name,
    bridgeId: formatBridgeId(parseBridgeId(sw.bridgeId)),
    root: sw.name === election.root,
    rootPort: rootPort.get(sw.name) ?? null,
    cost: cost.get(sw.name) ?? Number.POSITIVE_INFINITY,
    blockedPorts: blocked.get(sw.name) ?? [],
  }));

  return {
    root: election.root,
    rootBridgeId: election.bridgeId,
    roles,
  };
}

/** VLAN efetiva de uma porta access. */
export function accessVlan(port: SwitchPort): number {
  return port.vlan ?? DEFAULT_VLAN;
}

export function trunkNativeVlan(port: SwitchPort): number {
  return port.nativeVlan ?? DEFAULT_VLAN;
}

/** A porta transporta a VLAN? */
export function portAcceptsVlan(port: SwitchPort, vlan: number): boolean {
  if (port.disabled) return false;
  if (port.mode === "access") return accessVlan(port) === vlan;
  if (port.allowedVlans && !port.allowedVlans.includes(vlan)) return false;
  return true;
}

export interface IngressClassification {
  ok: boolean;
  vlan: number;
  tagged: boolean;
  reason: string;
}

/** Classifica o frame na VLAN de ingresso e aplica as regras de tag. */
export function classifyIngress(port: SwitchPort, frame: EthernetFrame): IngressClassification {
  if (port.disabled) {
    return { ok: false, vlan: 0, tagged: false, reason: `porta ${port.id} desligada` };
  }
  if (port.mode === "access") {
    if (frame.vlanId !== undefined) {
      return {
        ok: false,
        vlan: 0,
        tagged: false,
        reason: `frame marcado (VLAN ${frame.vlanId}) chegou em porta access ${port.id}`,
      };
    }
    return {
      ok: true,
      vlan: accessVlan(port),
      tagged: false,
      reason: `porta access ${port.id} -> VLAN ${accessVlan(port)}`,
    };
  }
  if (frame.vlanId !== undefined) {
    if (!portAcceptsVlan(port, frame.vlanId)) {
      return {
        ok: false,
        vlan: frame.vlanId,
        tagged: true,
        reason: `VLAN ${frame.vlanId} não permitida no trunk ${port.id}`,
      };
    }
    return {
      ok: true,
      vlan: frame.vlanId,
      tagged: true,
      reason: `trunk ${port.id} recebeu frame marcado na VLAN ${frame.vlanId}`,
    };
  }
  return {
    ok: true,
    vlan: trunkNativeVlan(port),
    tagged: false,
    reason: `trunk ${port.id} recebeu frame sem tag -> VLAN nativa ${trunkNativeVlan(port)}`,
  };
}

function agingMs(sw: Switch): number {
  return sw.macAgingMs ?? DEFAULT_MAC_AGING_MS;
}

/** Remove entradas vencidas e devolve quantas saíram. */
export function ageMacTable(sw: Switch, now = Date.now()): number {
  const before = sw.macTable.length;
  sw.macTable = sw.macTable.filter((entry) => now - entry.learnedAt <= agingMs(sw));
  return before - sw.macTable.length;
}

/** Consulta a tabela MAC na VLAN, ignorando (e removendo) entradas vencidas. */
export function lookupMac(
  sw: Switch,
  mac: Mac,
  vlan: number,
  now = Date.now(),
): MacTableEntry | undefined {
  const target = normalizeMac(mac);
  const entry = sw.macTable.find((item) => item.mac === target && item.vlan === vlan);
  if (!entry) return undefined;
  if (now - entry.learnedAt > agingMs(sw)) {
    sw.macTable = sw.macTable.filter((item) => item !== entry);
    return undefined;
  }
  return entry;
}

/**
 * Aprende (ou atualiza) o MAC de origem. Um MAC em outra VLAN é removido:
 * o mesmo endereço físico não deve aparecer em dois domínios ao mesmo tempo.
 */
export function learnMac(
  sw: Switch,
  mac: Mac,
  port: number,
  vlan: number,
  now = Date.now(),
): boolean {
  const target = normalizeMac(mac);
  if (isMulticastMac(target)) return false;
  const index = sw.macTable.findIndex(
    (item) => item.mac === target && item.vlan === vlan && item.port === port,
  );
  if (index >= 0) {
    sw.macTable[index].learnedAt = now;
    // O mesmo MAC não deve permanecer aprendido em outra VLAN.
    sw.macTable = sw.macTable.filter((item) => item.mac !== target || item.vlan === vlan);
    return false;
  }
  sw.macTable = sw.macTable.filter((item) => item.mac !== target);
  sw.macTable.push({ mac: target, port, vlan, learnedAt: now });
  return true;
}

/** Limpa a tabela MAC (opcionalmente só de uma porta). */
export function flushMacTable(sw: Switch, port?: number): number {
  const before = sw.macTable.length;
  sw.macTable = port === undefined ? [] : sw.macTable.filter((entry) => entry.port !== port);
  return before - sw.macTable.length;
}

export interface SwitchEgressFrame {
  port: number;
  frame: EthernetFrame;
}

export interface SwitchDecision {
  action: "forward" | "flood" | "filter" | "drop";
  vlan: number;
  ingressPort: number;
  egressPorts: number[];
  frames: SwitchEgressFrame[];
  reason: string;
  learned: boolean;
  /** Origem do MAC consultado, se conhecida. */
  destinationPort?: number;
}

function untaggedCopy(frame: EthernetFrame): EthernetFrame {
  return {
    src: frame.src,
    dst: frame.dst,
    etherType: frame.etherType,
    payload: frame.payload,
  };
}

/** Aplica/remove a tag 802.1Q conforme o modo da porta de saída. */
export function frameForEgress(
  frame: EthernetFrame,
  port: SwitchPort,
  vlan: number,
): EthernetFrame {
  if (port.mode === "trunk") {
    if (vlan === trunkNativeVlan(port)) return untaggedCopy(frame);
    return {
      src: frame.src,
      dst: frame.dst,
      etherType: frame.etherType,
      payload: frame.payload,
      vlanId: vlan,
      vlanPcp: frame.vlanPcp ?? 0,
      vlanDei: frame.vlanDei ?? false,
    };
  }
  return untaggedCopy(frame);
}

/**
 * Processa um frame em um switch.
 *
 * 1. classifica a VLAN de ingresso (access/trunk, tag/nativa);
 * 2. aprende o MAC de origem;
 * 3. consulta o MAC de destino na mesma VLAN;
 * 4. encaminha (known unicast), inunda (broadcast/unknown unicast) ou
 *    filtra (destino na mesma porta).
 */
export function switchFrame(
  sw: Switch,
  frame: EthernetFrame,
  ingressPort: number,
  now = Date.now(),
): SwitchDecision {
  const port = portOf(sw, ingressPort);
  if (!port) {
    return {
      action: "drop",
      vlan: 0,
      ingressPort,
      egressPorts: [],
      frames: [],
      reason: `porta ${ingressPort} não existe em ${sw.name}`,
      learned: false,
    };
  }
  const ingress = classifyIngress(port, frame);
  if (!ingress.ok) {
    return {
      action: "drop",
      vlan: ingress.vlan,
      ingressPort,
      egressPorts: [],
      frames: [],
      reason: ingress.reason,
      learned: false,
    };
  }

  const taggedFrame: EthernetFrame =
    frame.vlanId === undefined && ingress.tagged
      ? { ...frame, vlanId: ingress.vlan }
      : frame;
  const learned = learnMac(sw, frame.src, ingressPort, ingress.vlan, now);
  const dst = normalizeMac(frame.dst);

  if (isMulticastMac(dst)) {
    const egress = sw.ports
      .filter((item) => item.id !== ingressPort && portAcceptsVlan(item, ingress.vlan))
      .map((item) => item.id);
    return {
      action: egress.length > 0 ? "flood" : "drop",
      vlan: ingress.vlan,
      ingressPort,
      egressPorts: egress,
      frames: egress.map((id) => ({
        port: id,
        frame: frameForEgress(taggedFrame, portOf(sw, id)!, ingress.vlan),
      })),
      reason:
        egress.length > 0
          ? `destino ${dst} é broadcast/multicast: inunda VLAN ${ingress.vlan} pelas portas ${egress.join(", ")}`
          : `destino broadcast/multicast sem portas na VLAN ${ingress.vlan}`,
      learned,
    };
  }

  const known = lookupMac(sw, dst, ingress.vlan, now);
  if (known) {
    if (known.port === ingressPort) {
      return {
        action: "filter",
        vlan: ingress.vlan,
        ingressPort,
        egressPorts: [],
        frames: [],
        reason: `MAC ${dst} já está na porta de ingresso ${ingressPort}: filtro (não reenvia)`,
        learned,
        destinationPort: known.port,
      };
    }
    const egressPort = portOf(sw, known.port);
    if (!egressPort || !portAcceptsVlan(egressPort, ingress.vlan)) {
      return {
        action: "drop",
        vlan: ingress.vlan,
        ingressPort,
        egressPorts: [],
        frames: [],
        reason: `MAC ${dst} aprendido na porta ${known.port}, que não transporta VLAN ${ingress.vlan}`,
        learned,
        destinationPort: known.port,
      };
    }
    return {
      action: "forward",
      vlan: ingress.vlan,
      ingressPort,
      egressPorts: [known.port],
      frames: [{ port: known.port, frame: frameForEgress(taggedFrame, egressPort, ingress.vlan) }],
      reason: `MAC ${dst} conhecido na porta ${known.port}: known unicast`,
      learned,
      destinationPort: known.port,
    };
  }

  const egress = sw.ports
    .filter((item) => item.id !== ingressPort && portAcceptsVlan(item, ingress.vlan))
    .map((item) => item.id);
  return {
    action: egress.length > 0 ? "flood" : "drop",
    vlan: ingress.vlan,
    ingressPort,
    egressPorts: egress,
    frames: egress.map((id) => ({
      port: id,
      frame: frameForEgress(taggedFrame, portOf(sw, id)!, ingress.vlan),
    })),
    reason:
      egress.length > 0
        ? `MAC ${dst} desconhecido: unknown unicast, inunda VLAN ${ingress.vlan} pelas portas ${egress.join(", ")}`
        : `MAC ${dst} desconhecido e VLAN ${ingress.vlan} sem outras portas: descarta`,
    learned,
  };
}

export interface VlanTag {
  pcp: number;
  dei: boolean;
  vlanId: number;
}

/** Codifica a tag 802.1Q (4 bytes: TPID 0x8100 + PCP/DEI/VID). */
export function encodeDot1q(tag: VlanTag): Uint8Array {
  if (!Number.isInteger(tag.vlanId) || tag.vlanId < 0 || tag.vlanId > 4094) {
    throw new Error(`VLAN inválida: ${tag.vlanId}`);
  }
  if (!Number.isInteger(tag.pcp) || tag.pcp < 0 || tag.pcp > 7) {
    throw new Error(`PCP inválido: ${tag.pcp}`);
  }
  const tci = ((tag.pcp & 0x07) << 13) | ((tag.dei ? 1 : 0) << 12) | (tag.vlanId & 0x0fff);
  return new Uint8Array([0x81, 0x00, (tci >>> 8) & 0xff, tci & 0xff]);
}

/** Decodifica uma tag 802.1Q. */
export function decodeDot1q(bytes: Uint8Array, offset = 0): VlanTag {
  if (bytes.length < offset + 4) throw new Error("Tag 802.1Q truncada");
  const tpid = (bytes[offset] << 8) | bytes[offset + 1];
  if (tpid !== 0x8100) throw new Error(`TPID inesperado: 0x${tpid.toString(16)}`);
  const tci = (bytes[offset + 2] << 8) | bytes[offset + 3];
  return {
    pcp: (tci >>> 13) & 0x07,
    dei: ((tci >>> 12) & 0x01) === 1,
    vlanId: tci & 0x0fff,
  };
}

export function tagFrame(frame: EthernetFrame, vlanId: number, pcp = 0): EthernetFrame {
  if (!Number.isInteger(vlanId) || vlanId < 0 || vlanId > 4094) {
    throw new Error(`VLAN inválida: ${vlanId}`);
  }
  return { ...frame, vlanId, vlanPcp: pcp };
}

export function untagFrame(frame: EthernetFrame): EthernetFrame {
  return untaggedCopy(frame);
}

export function buildFrame(options: {
  src: Mac;
  dst: Mac;
  etherType: number;
  payload?: Uint8Array;
  vlanId?: number;
  vlanPcp?: number;
}): EthernetFrame {
  const frame: EthernetFrame = {
    src: normalizeMac(options.src),
    dst: normalizeMac(options.dst),
    etherType: options.etherType,
    payload: options.payload ?? new Uint8Array(0),
  };
  if (options.vlanId !== undefined) {
    frame.vlanId = options.vlanId;
    frame.vlanPcp = options.vlanPcp ?? 0;
  }
  return frame;
}

/** Narração de um enlace/porta para os traces do simulador. */
export function describePort(port: SwitchPort): string {
  if (port.mode === "trunk") {
    const allowed = port.allowedVlans ? port.allowedVlans.join(",") : "todas";
    return `trunk ${port.id} (nativa ${trunkNativeVlan(port)}; permitidas ${allowed})`;
  }
  return `access ${port.id} (VLAN ${accessVlan(port)})`;
}

/** Helper de trace usado pelo simulador, mantendo o formato padrão. */
export function traceL2(
  index: number,
  device: string,
  action: string,
  decision: string,
  extra: Partial<TraceStep> = {},
): TraceStep {
  return { index, layer: "L2", device, action, decision, ...extra };
}
