/**
 * Camada 3: longest-prefix match, tabela ARP, resolução ARP (com proxy),
 * encaminhamento hop-by-hop, TTL/ICMP time exceeded e detecção de loop.
 */

import { ArpTable, Ipv4, Mac, RouteEntry, Router, RouterInterface } from "./types";
import { networkInt, parseCidr, prefixToMaskInt } from "./ip";
import {
  Ipv4Packet,
  PROTO_ICMP,
  buildIpv4Packet,
  checksum,
  decrementTtl,
  parseIpv4Packet,
} from "./ipv4";

/** Longest-prefix match. Empate: menor métrica e depois a primeira rota. */
export function longestPrefixMatch(routes: RouteEntry[], dst: Ipv4): RouteEntry | null {
  let best: RouteEntry | null = null;
  let bestPrefix = -1;
  let bestMetric = Number.POSITIVE_INFINITY;
  const target = networkInt(dst, 32); // valida o IP
  for (const route of routes) {
    let network: number;
    let prefix: number;
    try {
      const parsed = parseCidr(`${route.network}/${route.prefix}`);
      network = networkInt(parsed.network, parsed.prefix);
      prefix = parsed.prefix;
    } catch {
      continue; // rota malformada não participa do match
    }
    if ((target & prefixToMaskInt(prefix)) >>> 0 !== network) continue;
    const metric = route.metric ?? 0;
    if (prefix > bestPrefix || (prefix === bestPrefix && metric < bestMetric)) {
      best = route;
      bestPrefix = prefix;
      bestMetric = metric;
    }
  }
  return best;
}

export function routeToCidr(route: RouteEntry): string {
  const parsed = parseCidr(`${route.network}/${route.prefix}`);
  return `${parsed.network}/${parsed.prefix}`;
}

export function formatRoute(route: RouteEntry): string {
  const target = routeToCidr(route);
  const hop = route.nextHop ? `via ${route.nextHop}` : "diretamente conectada";
  return `${target} ${hop} dev ${route.iface}${route.kind ? ` [${route.kind}]` : ""}`;
}

/** Rotas connected derivadas das interfaces com IP. */
export function connectedRoutes(router: Router): RouteEntry[] {
  const routes: RouteEntry[] = [];
  const seen = new Set<string>();
  for (const iface of router.interfaces) {
    if (!iface.ip || iface.prefix === null) continue;
    const cidr = parseCidr(`${iface.ip}/${iface.prefix}`);
    const key = `${cidr.network}/${cidr.prefix}`;
    if (seen.has(key)) continue;
    seen.add(key);
    routes.push({
      network: cidr.network,
      prefix: cidr.prefix,
      nextHop: null,
      iface: iface.name,
      kind: "connected",
    });
  }
  return routes;
}

export function findRouterInterface(router: Router, name: string): RouterInterface | undefined {
  return router.interfaces.find((iface) => iface.name === name);
}

export interface ArpEntry {
  ip: Ipv4;
  mac: Mac;
  learnedAt: number;
}

/** Cache ARP com expiração. */
export class ArpCache {
  private entries = new Map<Ipv4, ArpEntry>();

  constructor(
    initial: ArpTable = {},
    public maxAgeMs = 300_000,
  ) {
    for (const [ip, mac] of Object.entries(initial)) {
      this.entries.set(ip, { ip, mac, learnedAt: Date.now() });
    }
  }

  set(ip: Ipv4, mac: Mac, now = Date.now()): void {
    this.entries.set(ip, { ip, mac, learnedAt: now });
  }

  get(ip: Ipv4, now = Date.now()): Mac | null {
    const entry = this.entries.get(ip);
    if (!entry) return null;
    if (now - entry.learnedAt > this.maxAgeMs) {
      this.entries.delete(ip);
      return null;
    }
    return entry.mac;
  }

  delete(ip: Ipv4): boolean {
    return this.entries.delete(ip);
  }

  expire(now = Date.now()): number {
    let removed = 0;
    for (const [ip, entry] of this.entries) {
      if (now - entry.learnedAt > this.maxAgeMs) {
        this.entries.delete(ip);
        removed++;
      }
    }
    return removed;
  }

  toTable(): ArpTable {
    const table: ArpTable = {};
    for (const entry of this.entries.values()) table[entry.ip] = entry.mac;
    return table;
  }

  size(): number {
    return this.entries.size;
  }
}

export interface ArpResponder {
  name: string;
  ip: Ipv4;
  mac: Mac;
  /** Redes que este dispositivo responde por proxy ARP. */
  proxyFor?: string[];
}

export interface ArpResolution {
  target: Ipv4;
  mac: Mac | null;
  answeredBy: string | null;
  viaProxy: boolean;
  steps: string[];
}

/**
 * Resolve ARP: primeiro procura o dono exato do IP; depois um proxy que
 * anuncie a rede do alvo (`proxyFor`). Sem resposta, devolve mac=null.
 */
export function arpResolve(
  requester: { name: string; ip: Ipv4; mac: Mac },
  targetIp: Ipv4,
  responders: ArpResponder[],
): ArpResolution {
  const steps: string[] = [
    `${requester.name} envia ARP request em broadcast: "quem tem ${targetIp}? diga para ${requester.ip}"`,
  ];
  const exact = responders.find((item) => item.ip === targetIp && item.ip !== requester.ip);
  if (exact) {
    steps.push(`${exact.name} responde unicast: "${targetIp} é ${exact.mac}"`);
    return { target: targetIp, mac: exact.mac, answeredBy: exact.name, viaProxy: false, steps };
  }
  for (const responder of responders) {
    if (responder.ip === requester.ip) continue;
    const announced = responder.proxyFor ?? [];
    const proxied = announced.some((cidrText) => {
      const cidr = parseCidr(cidrText);
      return networkInt(targetIp, cidr.prefix) === networkInt(cidr.network, cidr.prefix);
    });
    if (proxied) {
      steps.push(
        `${responder.name} responde por proxy ARP: "${targetIp} está fora da sub-rede, envie para ${responder.mac}"`,
      );
      return {
        target: targetIp,
        mac: responder.mac,
        answeredBy: responder.name,
        viaProxy: true,
        steps,
      };
    }
  }
  steps.push(`Nenhum vizinho respondeu ao ARP para ${targetIp}: destino inalcançável na camada 2`);
  return { target: targetIp, mac: null, answeredBy: null, viaProxy: false, steps };
}

/** Payload ICMP type 11 (time exceeded), code 0. */
export function buildIcmpTimeExceededPayload(original: Ipv4Packet): Uint8Array {
  const quoted = original.raw.subarray(0, Math.min(original.totalLength, original.ihl + 8));
  const payload = new Uint8Array(8 + quoted.length);
  payload[0] = 11; // type: time exceeded
  payload[1] = 0; // code: TTL expired in transit
  payload[2] = 0;
  payload[3] = 0;
  payload.set(quoted, 8);
  const sum = checksum(payload);
  payload[2] = (sum >>> 8) & 0xff;
  payload[3] = sum & 0xff;
  return payload;
}

/** Constrói o pacote ICMP time exceeded do roteador para a origem. */
export function buildIcmpTimeExceeded(
  original: Ipv4Packet | Uint8Array,
  routerIp: Ipv4,
  options: { id?: number; ttl?: number } = {},
): Ipv4Packet {
  const parsed = original instanceof Uint8Array ? parseIpv4Packet(original) : original;
  return buildIpv4Packet({
    src: routerIp,
    dst: parsed.src,
    protocol: PROTO_ICMP,
    payload: buildIcmpTimeExceededPayload(parsed),
    ttl: options.ttl ?? 64,
    id: options.id ?? parsed.id,
  });
}

/** Payload ICMP type 3 (destination unreachable). */
export function buildIcmpUnreachablePayload(original: Ipv4Packet, code = 1): Uint8Array {
  const quoted = original.raw.subarray(0, Math.min(original.totalLength, original.ihl + 8));
  const payload = new Uint8Array(8 + quoted.length);
  payload[0] = 3;
  payload[1] = code & 0xff;
  payload.set(quoted, 8);
  const sum = checksum(payload);
  payload[2] = (sum >>> 8) & 0xff;
  payload[3] = sum & 0xff;
  return payload;
}

export function buildIcmpUnreachable(
  original: Ipv4Packet | Uint8Array,
  routerIp: Ipv4,
  code = 1,
): Ipv4Packet {
  const parsed = original instanceof Uint8Array ? parseIpv4Packet(original) : original;
  return buildIpv4Packet({
    src: routerIp,
    dst: parsed.src,
    protocol: PROTO_ICMP,
    payload: buildIcmpUnreachablePayload(parsed, code),
    id: parsed.id,
  });
}

export interface RouteDecision {
  action: "local" | "forward" | "drop";
  route: RouteEntry | null;
  nextHop: Ipv4 | null;
  iface: RouterInterface | null;
  /** TTL do pacote encaminhado (quando action=forward). */
  ttl?: number;
  /** Pacote com TTL decrementado e checksum recalculado. */
  packet?: Ipv4Packet;
  /** ICMP gerado em caso de descarte. */
  icmp?: Ipv4Packet;
  reason: string;
}

/**
 * Decide o que um roteador faz com um pacote:
 *  - entrega local se o destino é uma interface do próprio roteador;
 *  - consulta LPM; sem rota -> descarte (ICMP unreachable);
 *  - TTL <= 1 -> descarte + ICMP time exceeded;
 *  - caso contrário decrementa TTL e encaminha ao próximo salto.
 */
export function routePacket(router: Router, packet: Ipv4Packet | Uint8Array): RouteDecision {
  const parsed = packet instanceof Uint8Array ? parseIpv4Packet(packet) : packet;
  const localInterface = router.interfaces.find(
    (iface) => iface.ip === parsed.dst && iface.ip !== null,
  );
  if (localInterface) {
    return {
      action: "local",
      route: null,
      nextHop: null,
      iface: localInterface,
      reason: `destino ${parsed.dst} é endereço local da interface ${localInterface.name}`,
    };
  }

  const route = longestPrefixMatch(router.routes, parsed.dst);
  if (!route) {
    const fallback = router.interfaces.find((iface) => iface.ip);
    return {
      action: "drop",
      route: null,
      nextHop: null,
      iface: null,
      icmp: fallback ? buildIcmpUnreachable(parsed, fallback.ip!, 1) : undefined,
      reason: `sem rota para ${parsed.dst}`,
    };
  }

  const iface = findRouterInterface(router, route.iface) ?? null;
  if (!iface || !iface.ip) {
    return {
      action: "drop",
      route,
      nextHop: route.nextHop ?? null,
      iface,
      reason: `rota aponta para interface inexistente/sem IP: ${route.iface}`,
    };
  }

  if (parsed.ttl <= 1) {
    return {
      action: "drop",
      route,
      nextHop: route.nextHop ?? parsed.dst,
      iface,
      icmp: buildIcmpTimeExceeded(parsed, iface.ip),
      reason: `TTL=${parsed.ttl} chegou a zero antes de ${routeToCidr(route)}: ICMP time exceeded`,
    };
  }

  const forwarded = decrementTtl(parsed);
  return {
    action: "forward",
    route,
    nextHop: route.nextHop ?? parsed.dst,
    iface,
    ttl: forwarded.ttl,
    packet: forwarded,
    reason: `rota ${routeToCidr(route)} (prefixo /${route.prefix}) via ${
      route.nextHop ?? parsed.dst
    } por ${iface.name}; TTL ${parsed.ttl} -> ${forwarded.ttl}`,
  };
}

/** Detecta loops de roteamento por repetição de (roteador, próximo salto). */
export class LoopDetector {
  private counts = new Map<string, number>();
  hops = 0;

  constructor(
    private maxHops = 16,
    private maxRepeats = 2,
  ) {}

  /**
   * Registra uma visita. Retorna `{ loop, reason }` quando o limite de
   * saltos ou de repetições é atingido.
   */
  visit(key: string): { loop: boolean; reason?: string } {
    this.hops++;
    const count = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, count);
    if (this.hops > this.maxHops) {
      return { loop: true, reason: `limite de ${this.maxHops} saltos atingido` };
    }
    if (count > this.maxRepeats) {
      return { loop: true, reason: `salto ${key} repetido ${count} vezes` };
    }
    return { loop: false };
  }
}

/** Gera um responder ARP para cada interface do roteador. */
export function routerArpResponders(router: Router): ArpResponder[] {
  const proxyFor = router.proxyArp
    ? router.routes.map((route) => routeToCidr(route))
    : [];
  return router.interfaces
    .filter((iface): iface is RouterInterface & { ip: Ipv4 } => iface.ip !== null)
    .map((iface) => ({
      name: `${router.name}:${iface.name}`,
      ip: iface.ip,
      mac: iface.mac,
      proxyFor,
    }));
}

/** Interface do roteador que pertence à sub-rede do IP informado. */
export function interfaceForHost(router: Router, ip: Ipv4): RouterInterface | null {
  for (const iface of router.interfaces) {
    if (!iface.ip || iface.prefix === null) continue;
    if (networkInt(ip, iface.prefix) === networkInt(iface.ip, iface.prefix)) return iface;
  }
  return null;
}
