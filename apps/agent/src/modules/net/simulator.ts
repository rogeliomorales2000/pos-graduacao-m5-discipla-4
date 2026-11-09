/**
 * Simulador didático de ponta a ponta.
 *
 * `buildScenario` cria topologias prontas e `send` executa um pacote
 * passo a passo, produzindo traces legíveis. O caminho é realmente
 * calculado: ARP, aprendizado MAC, VLANs, longest-prefix match e TTL.
 */

import {
  ETHERTYPE_ARP,
  ETHERTYPE_IPV4,
  EthernetFrame,
  Host,
  Ipv4,
  LinkEnd,
  Mac,
  Router,
  RouterInterface,
  Switch,
  SwitchPort,
  Topology,
  TraceStep,
} from "./types";
import { isValidIpv4, parseCidr, sameSubnet } from "./ip";
import { Ipv4Packet, PROTO_ICMP, buildIpv4Packet } from "./ipv4";
import {
  DEFAULT_VLAN,
  MAC_BROADCAST,
  accessVlan,
  buildFrame,
  lookupMac,
  portAcceptsVlan,
  switchFrame,
  trunkNativeVlan,
} from "./l2";
import {
  ArpResponder,
  LoopDetector,
  arpResolve,
  connectedRoutes,
  routePacket,
  routeToCidr,
} from "./l3";

/* ------------------------------------------------------------------ */
/* Construção de cenários                                              */
/* ------------------------------------------------------------------ */

function mac(n: number): Mac {
  return `02:00:00:00:00:${n.toString(16).padStart(2, "0")}`;
}

function h(
  name: string,
  ip: Ipv4,
  prefix: number,
  macId: number,
  gateway?: Ipv4,
  vlan?: number,
): Host {
  return { name, ip, prefix, mac: mac(macId), gateway: gateway ?? null, vlan };
}

function accessSwitch(
  name: string,
  bridgeMacId: number,
  ports: Array<{ id: number; vlan: number }>,
): Switch {
  return {
    name,
    bridgeId: `32768.${mac(bridgeMacId)}`,
    macTable: [],
    macAgingMs: 300_000,
    ports: ports.map((port) => ({ id: port.id, mode: "access", vlan: port.vlan })),
  };
}

function link(
  aDevice: string,
  aPort: number | string,
  bDevice: string,
  bPort: number | string,
): { a: LinkEnd; b: LinkEnd } {
  return { a: { device: aDevice, port: aPort }, b: { device: bDevice, port: bPort } };
}

function withConnectedRoutes(router: Router, extra: Router["routes"] = []): Router {
  router.routes = [...connectedRoutes(router), ...extra];
  return router;
}

export interface ScenarioInfo {
  name: string;
  title: string;
  description: string;
}

export const SCENARIOS: ScenarioInfo[] = [
  {
    name: "single-switch",
    title: "Switch único",
    description: "Três hosts no mesmo domínio de broadcast; mostra aprendizado MAC e flooding.",
  },
  {
    name: "vlans",
    title: "Isolamento de VLANs",
    description: "Duas VLANs no mesmo switch: o broadcast de uma não alcança a outra.",
  },
  {
    name: "router-on-a-stick",
    title: "Roteamento inter-VLAN",
    description: "Um roteador com subinterfaces 802.1Q encaminha entre as VLANs 10 e 20.",
  },
  {
    name: "static-routes",
    title: "Rotas estáticas",
    description: "Dois roteadores e duas LANs; cada roteador conhece a rede remota por rota estática.",
  },
  {
    name: "routing-loop",
    title: "Loop de roteamento",
    description: "Rotas default apontando uma para a outra; o simulador detecta o loop.",
  },
  {
    name: "stp",
    title: "Triângulo com STP",
    description: "Três switches em triângulo; a eleição de root usa o menor bridge ID.",
  },
];

/** Cria uma topologia pronta pelo nome. */
export function buildScenario(name: string): Topology {
  switch (name) {
    case "single-switch":
      return singleSwitch();
    case "vlans":
      return vlanScenario();
    case "router-on-a-stick":
      return routerOnAStick();
    case "static-routes":
      return staticRoutes();
    case "routing-loop":
      return routingLoop();
    case "stp":
      return stpTriangle();
    default:
      throw new Error(
        `Cenário desconhecido: "${name}". Disponíveis: ${SCENARIOS.map((item) => item.name).join(", ")}`,
      );
  }
}

function singleSwitch(): Topology {
  return {
    name: "single-switch",
    hosts: [
      h("h1", "192.168.10.10", 24, 0x11),
      h("h2", "192.168.10.20", 24, 0x12),
      h("h3", "192.168.10.30", 24, 0x13),
    ],
    switches: [accessSwitch("sw1", 0x01, [
      { id: 1, vlan: 1 },
      { id: 2, vlan: 1 },
      { id: 3, vlan: 1 },
      { id: 4, vlan: 1 },
    ])],
    routers: [],
    links: [link("h1", 0, "sw1", 1), link("h2", 0, "sw1", 2), link("h3", 0, "sw1", 3)],
    vlanNames: { 1: "default" },
  };
}

function vlanScenario(): Topology {
  return {
    name: "vlans",
    hosts: [
      h("h1", "10.0.0.10", 24, 0x21, undefined, 10),
      h("h2", "10.0.0.20", 24, 0x22, undefined, 10),
      h("h3", "10.0.0.30", 24, 0x23, undefined, 20),
      h("h4", "10.0.0.40", 24, 0x24, undefined, 20),
    ],
    switches: [
      accessSwitch("sw1", 0x02, [
        { id: 1, vlan: 10 },
        { id: 2, vlan: 10 },
        { id: 3, vlan: 20 },
        { id: 4, vlan: 20 },
      ]),
    ],
    routers: [],
    links: [
      link("h1", 0, "sw1", 1),
      link("h2", 0, "sw1", 2),
      link("h3", 0, "sw1", 3),
      link("h4", 0, "sw1", 4),
    ],
    vlanNames: { 10: "vendas", 20: "ti" },
  };
}

function routerOnAStick(): Topology {
  const r1: Router = {
    name: "r1",
    proxyArp: false,
    arpTable: {},
    interfaces: [
      { name: "gi0/0", mac: mac(0x31), ip: null, prefix: null },
      {
        name: "gi0/0.10",
        mac: mac(0x3a),
        ip: "192.168.10.1",
        prefix: 24,
        vlan: 10,
        parent: "gi0/0",
      },
      {
        name: "gi0/0.20",
        mac: mac(0x3b),
        ip: "192.168.20.1",
        prefix: 24,
        vlan: 20,
        parent: "gi0/0",
      },
    ],
    routes: [],
  };
  withConnectedRoutes(r1);
  return {
    name: "router-on-a-stick",
    hosts: [
      h("h1", "192.168.10.10", 24, 0x41, "192.168.10.1", 10),
      h("h2", "192.168.10.20", 24, 0x42, "192.168.10.1", 10),
      h("h3", "192.168.20.10", 24, 0x43, "192.168.20.1", 20),
      h("h4", "192.168.20.20", 24, 0x44, "192.168.20.1", 20),
    ],
    switches: [
      {
        name: "sw1",
        bridgeId: `32768.${mac(0x03)}`,
        macTable: [],
        macAgingMs: 300_000,
        ports: [
          { id: 1, mode: "access", vlan: 10 },
          { id: 2, mode: "access", vlan: 10 },
          { id: 3, mode: "access", vlan: 20 },
          { id: 4, mode: "access", vlan: 20 },
          { id: 5, mode: "trunk", allowedVlans: [10, 20], nativeVlan: 1 },
        ],
      },
    ],
    routers: [r1],
    links: [
      link("h1", 0, "sw1", 1),
      link("h2", 0, "sw1", 2),
      link("h3", 0, "sw1", 3),
      link("h4", 0, "sw1", 4),
      link("r1", "gi0/0", "sw1", 5),
    ],
    vlanNames: { 10: "vendas", 20: "ti" },
  };
}

function staticRoutes(): Topology {
  const r1: Router = {
    name: "r1",
    arpTable: {},
    interfaces: [
      { name: "g0/0", mac: mac(0x51), ip: "192.168.1.1", prefix: 24 },
      { name: "g0/1", mac: mac(0x52), ip: "10.0.0.1", prefix: 30 },
    ],
    routes: [],
    proxyArp: false,
  };
  const r2: Router = {
    name: "r2",
    arpTable: {},
    interfaces: [
      { name: "g0/0", mac: mac(0x61), ip: "192.168.2.1", prefix: 24 },
      { name: "g0/1", mac: mac(0x62), ip: "10.0.0.2", prefix: 30 },
    ],
    routes: [],
    proxyArp: false,
  };
  withConnectedRoutes(r1, [
    {
      network: "192.168.2.0",
      prefix: 24,
      nextHop: "10.0.0.2",
      iface: "g0/1",
      kind: "static",
      metric: 10,
    },
  ]);
  withConnectedRoutes(r2, [
    {
      network: "192.168.1.0",
      prefix: 24,
      nextHop: "10.0.0.1",
      iface: "g0/1",
      kind: "static",
      metric: 10,
    },
  ]);
  return {
    name: "static-routes",
    hosts: [
      h("h1", "192.168.1.10", 24, 0x53, "192.168.1.1"),
      h("h2", "192.168.2.10", 24, 0x63, "192.168.2.1"),
    ],
    switches: [],
    routers: [r1, r2],
    links: [
      link("h1", 0, "r1", "g0/0"),
      link("r1", "g0/1", "r2", "g0/1"),
      link("r2", "g0/0", "h2", 0),
    ],
  };
}

function routingLoop(): Topology {
  const r1: Router = {
    name: "r1",
    arpTable: {},
    proxyArp: false,
    interfaces: [
      { name: "g0/0", mac: mac(0x71), ip: "192.168.1.1", prefix: 24 },
      { name: "g0/1", mac: mac(0x72), ip: "10.0.0.1", prefix: 30 },
    ],
    routes: [],
  };
  const r2: Router = {
    name: "r2",
    arpTable: {},
    proxyArp: false,
    interfaces: [
      { name: "g0/0", mac: mac(0x81), ip: "192.168.2.1", prefix: 24 },
      { name: "g0/1", mac: mac(0x82), ip: "10.0.0.2", prefix: 30 },
    ],
    routes: [],
  };
  withConnectedRoutes(r1, [
    { network: "0.0.0.0", prefix: 0, nextHop: "10.0.0.2", iface: "g0/1", kind: "default" },
  ]);
  withConnectedRoutes(r2, [
    { network: "0.0.0.0", prefix: 0, nextHop: "10.0.0.1", iface: "g0/1", kind: "default" },
  ]);
  return {
    name: "routing-loop",
    hosts: [h("h1", "192.168.1.10", 24, 0x73, "192.168.1.1")],
    switches: [],
    routers: [r1, r2],
    links: [link("h1", 0, "r1", "g0/0"), link("r1", "g0/1", "r2", "g0/1")],
  };
}

function stpTriangle(): Topology {
  const sw1 = accessSwitch("sw1", 0x04, [{ id: 1, vlan: 1 }, { id: 2, vlan: 1 }, { id: 3, vlan: 1 }]);
  const sw2 = accessSwitch("sw2", 0x05, [{ id: 1, vlan: 1 }, { id: 2, vlan: 1 }, { id: 3, vlan: 1 }]);
  const sw3 = accessSwitch("sw3", 0x06, [{ id: 1, vlan: 1 }, { id: 2, vlan: 1 }, { id: 3, vlan: 1 }]);
  // Custo diferente para tornar o caminho determinístico no exemplo.
  sw2.ports[2].cost = 4;
  sw3.ports[2].cost = 4;
  return {
    name: "stp",
    hosts: [h("h1", "10.10.0.10", 24, 0x91), h("h2", "10.10.0.20", 24, 0x92), h("h3", "10.10.0.30", 24, 0x93)],
    switches: [sw1, sw2, sw3],
    routers: [],
    links: [
      link("h1", 0, "sw1", 1),
      link("h2", 0, "sw2", 1),
      link("h3", 0, "sw3", 1),
      link("sw1", 2, "sw2", 2),
      link("sw2", 3, "sw3", 2),
      link("sw3", 3, "sw1", 3),
    ],
    vlanNames: { 1: "default" },
  };
}

/* ------------------------------------------------------------------ */
/* Índice e anexos (quem está plugado em quê)                          */
/* ------------------------------------------------------------------ */

interface TopologyIndex {
  hosts: Map<string, Host>;
  switches: Map<string, Switch>;
  routers: Map<string, Router>;
}

interface Attachment {
  device: string;
  kind: "host" | "router";
  /** Nome da interface do roteador (quando kind=router). */
  iface?: string;
  ip: Ipv4;
  mac: Mac;
  vlan: number;
  /** Extremidade do cabo usada por este anexo. */
  end: LinkEnd;
  router?: Router;
  proxyFor?: string[];
}

function buildIndex(topology: Topology): TopologyIndex {
  return {
    hosts: new Map(topology.hosts.map((item) => [item.name, item])),
    switches: new Map(topology.switches.map((item) => [item.name, item])),
    routers: new Map(topology.routers.map((item) => [item.name, item])),
  };
}

function sameEnd(a: LinkEnd, b: LinkEnd): boolean {
  return a.device === b.device && String(a.port) === String(b.port);
}

function otherEnd(topology: Topology, end: LinkEnd): LinkEnd | null {
  for (const item of topology.links) {
    if (sameEnd(item.a, end)) return { ...item.b };
    if (sameEnd(item.b, end)) return { ...item.a };
  }
  return null;
}

function neighborVlan(topology: Topology, index: TopologyIndex, end: LinkEnd): number {
  const other = otherEnd(topology, end);
  if (!other) return DEFAULT_VLAN;
  const sw = index.switches.get(other.device);
  if (sw) {
    const port = sw.ports.find((item) => item.id === other.port);
    if (!port) return DEFAULT_VLAN;
    return port.mode === "access" ? accessVlan(port) : trunkNativeVlan(port);
  }
  const host = index.hosts.get(other.device);
  if (host) return host.vlan ?? DEFAULT_VLAN;
  const router = index.routers.get(other.device);
  if (router) {
    const iface = router.interfaces.find(
      (item) => (item.parent ?? item.name) === String(other.port),
    );
    return iface?.vlan ?? DEFAULT_VLAN;
  }
  return DEFAULT_VLAN;
}

function hostAttachment(index: TopologyIndex, topology: Topology, host: Host): Attachment {
  return {
    device: host.name,
    kind: "host",
    ip: host.ip,
    mac: host.mac,
    vlan: host.vlan ?? neighborVlan(topology, index, { device: host.name, port: 0 }),
    end: { device: host.name, port: 0 },
  };
}

function routerAttachment(router: Router, iface: RouterInterface): Attachment {
  const proxyFor = router.proxyArp
    ? router.routes
        .filter((route) => route.nextHop !== null && route.nextHop !== undefined)
        .map((route) => routeToCidr(route))
    : undefined;
  return {
    device: router.name,
    kind: "router",
    iface: iface.name,
    ip: iface.ip!,
    mac: iface.mac,
    vlan: iface.vlan ?? DEFAULT_VLAN,
    end: { device: router.name, port: iface.parent ?? iface.name },
    router,
    proxyFor,
  };
}

/** Anexos que compartilham o mesmo domínio de broadcast/VLAN de `from`. */
function segmentAttachments(
  topology: Topology,
  index: TopologyIndex,
  from: Attachment,
): Attachment[] {
  const result = new Map<string, Attachment>();
  const visitedPorts = new Set<string>();
  const queue: Array<{ end: LinkEnd; vlan: number }> = [{ end: from.end, vlan: from.vlan }];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const other = otherEnd(topology, current.end);
    if (!other) continue;
    const sw = index.switches.get(other.device);
    if (sw) {
      const ingress = sw.ports.find((item) => item.id === other.port);
      if (!ingress || !portAcceptsVlan(ingress, current.vlan)) continue;
      const key = `${sw.name}:${ingress.id}:${current.vlan}`;
      if (visitedPorts.has(key)) continue;
      visitedPorts.add(key);
      for (const port of sw.ports) {
        if (port.id === ingress.id) continue;
        if (!portAcceptsVlan(port, current.vlan)) continue;
        queue.push({ end: { device: sw.name, port: port.id }, vlan: current.vlan });
      }
      continue;
    }
    const host = index.hosts.get(other.device);
    if (host) {
      const vlan = host.vlan ?? current.vlan;
      if (vlan === current.vlan && host.name !== from.device) {
        const attachment = hostAttachment(index, topology, host);
        result.set(`host:${host.name}`, attachment);
      }
      continue;
    }
    const router = index.routers.get(other.device);
    if (router) {
      for (const iface of router.interfaces) {
        if (!iface.ip) continue;
        if ((iface.parent ?? iface.name) !== String(other.port)) continue;
        if (iface.vlan !== undefined && iface.vlan !== current.vlan) continue;
        const attachment = routerAttachment(router, iface);
        attachment.vlan = iface.vlan ?? current.vlan;
        result.set(`router:${router.name}:${iface.name}`, attachment);
      }
    }
  }

  return [...result.values()];
}

/* ------------------------------------------------------------------ */
/* Caminho L2 e traces                                                 */
/* ------------------------------------------------------------------ */

interface L2Hop {
  switch: Switch;
  ingress: number;
  egress: number;
}

function candidateEgress(
  sw: Switch,
  ingress: number,
  vlan: number,
  dstMac: Mac,
  now: number,
): number[] {
  if (dstMac !== MAC_BROADCAST) {
    const known = lookupMac(sw, dstMac, vlan, now);
    if (known) return known.port === ingress ? [] : [known.port];
  }
  return sw.ports
    .filter((port) => port.id !== ingress && portAcceptsVlan(port, vlan))
    .map((port) => port.id);
}

function findL2Path(
  topology: Topology,
  index: TopologyIndex,
  from: LinkEnd,
  to: LinkEnd,
  vlan: number,
  dstMac: Mac,
  now: number,
): L2Hop[] | null {
  const visited = new Set<string>();
  const hops: L2Hop[] = [];

  const walk = (end: LinkEnd): boolean => {
    if (sameEnd(end, to)) return true;
    const other = otherEnd(topology, end);
    if (!other) return false;
    if (sameEnd(other, to)) return true;
    const sw = index.switches.get(other.device);
    if (!sw) return false;
    const ingress = Number(other.port);
    const port = sw.ports.find((item) => item.id === ingress);
    if (!port || !portAcceptsVlan(port, vlan)) return false;
    const key = `${sw.name}:${ingress}:${vlan}`;
    if (visited.has(key)) return false;
    visited.add(key);
    for (const egress of candidateEgress(sw, ingress, vlan, dstMac, now)) {
      hops.push({ switch: sw, ingress, egress });
      if (walk({ device: sw.name, port: egress })) return true;
      hops.pop();
    }
    return false;
  };

  return walk(from) ? hops : null;
}

class Tracer {
  readonly steps: TraceStep[] = [];

  add(
    layer: TraceStep["layer"],
    device: string,
    action: string,
    decision: string,
    extra: Partial<TraceStep> = {},
  ): void {
    this.steps.push({
      index: this.steps.length + 1,
      layer,
      device,
      action,
      decision,
      ok: true,
      ...extra,
    });
  }
}

function ingressTag(port: SwitchPort, vlan: number): number | undefined {
  if (port.mode === "access") return undefined;
  return vlan === trunkNativeVlan(port) ? undefined : vlan;
}

/**
 * Percorre um frame pelo caminho L2 calculado, acionando o switch real
 * (`switchFrame`) para aprender MAC e decidir flood/forward.
 */
function traceL2Frame(
  tracer: Tracer,
  topology: Topology,
  index: TopologyIndex,
  from: LinkEnd,
  to: LinkEnd,
  vlan: number,
  srcMac: Mac,
  dstMac: Mac,
  etherType: number,
  label: string,
  now: number,
): boolean {
  const hops = findL2Path(topology, index, from, to, vlan, dstMac, now);
  if (!hops) {
    tracer.add(
      "L2",
      from.device,
      `envia ${label}`,
      `sem caminho L2 até ${to.device} na VLAN ${vlan}`,
      { table: "tabela MAC", ok: false, detail: `origem ${srcMac} destino ${dstMac}` },
    );
    return false;
  }

  for (const hop of hops) {
    const ingressPort = hop.switch.ports.find((item) => item.id === hop.ingress)!;
    const frame: EthernetFrame = buildFrame({
      src: srcMac,
      dst: dstMac,
      etherType,
      vlanId: ingressTag(ingressPort, vlan),
    });
    const decision = switchFrame(hop.switch, frame, hop.ingress, now);
    const accepted =
      (decision.action === "forward" || decision.action === "flood") &&
      decision.egressPorts.includes(hop.egress);
    tracer.add(
      "L2",
      hop.switch.name,
      `recebe ${label} ${srcMac} -> ${dstMac} na porta ${hop.ingress}`,
      `${decision.action}: ${decision.reason}`,
      {
        table: "tabela MAC",
        detail: `VLAN ${decision.vlan}; ingress ${hop.ingress}; egress [${decision.egressPorts.join(
          ", ",
        )}]; aprendizado ${decision.learned ? "sim" : "não"}; caminho segue pela porta ${hop.egress}`,
        ok: accepted,
      },
    );
    if (!accepted) return false;
  }

  const tag = vlan === DEFAULT_VLAN ? "sem tag" : `VLAN ${vlan}`;
  tracer.add("L2", to.device, `entrega ${label}`, `frame entregue na porta ${String(to.port)} (${tag})`, {
    detail: `src ${srcMac}; dst ${dstMac}`,
  });
  return true;
}

/* ------------------------------------------------------------------ */
/* ARP no segmento                                                     */
/* ------------------------------------------------------------------ */

interface ResolvedArp {
  mac: Mac;
  answered: Attachment;
  viaProxy: boolean;
}

function resolveArpInSegment(
  tracer: Tracer,
  topology: Topology,
  index: TopologyIndex,
  sender: Attachment,
  targetIp: Ipv4,
  now: number,
): ResolvedArp | null {
  const members = segmentAttachments(topology, index, sender);
  const responders: ArpResponder[] = members.map((item) => ({
    name: item.kind === "host" ? item.device : `${item.device}:${item.iface}`,
    ip: item.ip,
    mac: item.mac,
    proxyFor: item.proxyFor,
  }));

  tracer.add(
    "ARP",
    sender.device,
    `ARP request para ${targetIp}`,
    `broadcast na VLAN ${sender.vlan} alcança ${members.length} vizinho(s)`,
    {
      table: "cache ARP",
      detail: members.map((item) => `${item.device}(${item.ip})`).join(", ") || "nenhum vizinho",
    },
  );

  const resolution = arpResolve(
    { name: sender.device, ip: sender.ip, mac: sender.mac },
    targetIp,
    responders,
  );
  for (const step of resolution.steps) {
    tracer.add("ARP", sender.device, "ARP", step, { table: "cache ARP", ok: resolution.mac !== null });
  }
  if (!resolution.mac || !resolution.answeredBy) {
    tracer.add("L2", sender.device, "envia frame IPv4", "descarte: ARP sem resposta", { ok: false });
    return null;
  }

  const answered =
    members.find(
      (item) =>
        item.mac === resolution.mac &&
        (item.ip === targetIp || resolution.viaProxy) &&
        (item.kind === "host"
          ? item.device === resolution.answeredBy
          : `${item.device}:${item.iface}` === resolution.answeredBy),
    ) ?? members.find((item) => item.mac === resolution.mac);
  if (!answered) {
    tracer.add("ARP", sender.device, "ARP", "resposta inconsistente: MAC não pertence ao segmento", {
      ok: false,
    });
    return null;
  }

  if (resolution.viaProxy) {
    tracer.add(
      "L3",
      answered.device,
      "proxy ARP",
      `${targetIp} está fora do segmento; ${answered.device} responde com ${answered.mac}`,
      { table: "tabela de rotas" },
    );
  }

  // Simula request (broadcast) e reply (unicast) para aprendizado MAC real.
  traceL2Frame(
    tracer,
    topology,
    index,
    sender.end,
    answered.end,
    sender.vlan,
    sender.mac,
    MAC_BROADCAST,
    ETHERTYPE_ARP,
    "ARP request",
    now,
  );
  const replyOk = traceL2Frame(
    tracer,
    topology,
    index,
    answered.end,
    sender.end,
    sender.vlan,
    answered.mac,
    sender.mac,
    ETHERTYPE_ARP,
    "ARP reply",
    now,
  );
  if (!replyOk) return null;

  return { mac: resolution.mac, answered, viaProxy: resolution.viaProxy };
}

/* ------------------------------------------------------------------ */
/* send()                                                              */
/* ------------------------------------------------------------------ */

function findHost(index: TopologyIndex, ref: string): Host | undefined {
  return index.hosts.get(ref) ?? [...index.hosts.values()].find((item) => item.ip === ref);
}

/** Executa um pacote de `src` para `dst` e devolve os passos narrados. */
export function send(topology: Topology, src: string, dst: string, payload = "ping"): TraceStep[] {
  const tracer = new Tracer();
  const index = buildIndex(topology);
  const source = findHost(index, src);
  if (!source) throw new Error(`Host de origem desconhecido: ${src}`);

  const destination = findHost(index, dst);
  const dstIp = destination?.ip ?? (isValidIpv4(dst) ? dst : null);
  if (!dstIp) throw new Error(`Destino desconhecido (nem host nem IPv4): ${dst}`);

  const sourceAttachment = hostAttachment(index, topology, source);
  tracer.add("L3", source.name, "origem do pacote", `${source.ip}/${source.prefix} -> ${dstIp}`, {
    detail: `MAC ${source.mac}; gateway ${source.gateway ?? "nenhum"}; payload "${payload}"`,
    ttl: 64,
  });

  if (dstIp === source.ip) {
    tracer.add("L4+", source.name, "entrega local", "origem e destino são o mesmo host", {
      layer: "L4+",
    });
    return tracer.steps;
  }

  const localSubnet = sameSubnet(source.ip, dstIp, source.prefix);
  let nextHopIp: Ipv4;
  if (localSubnet) {
    nextHopIp = dstIp;
    tracer.add(
      "L3",
      source.name,
      "consulta tabela de rotas",
      `${dstIp} está na sub-rede local ${parseCidr(`${source.ip}/${source.prefix}`).network}/${
        source.prefix
      }: envio direto`,
      { table: "tabela de rotas", detail: "sem gateway" },
    );
  } else if (source.gateway) {
    nextHopIp = source.gateway;
    tracer.add(
      "L3",
      source.name,
      "consulta tabela de rotas",
      `${dstIp} é remoto: usa gateway padrão ${source.gateway}`,
      { table: "tabela de rotas" },
    );
  } else {
    tracer.add(
      "L3",
      source.name,
      "consulta tabela de rotas",
      `${dstIp} é remoto e o host não tem gateway: descarte`,
      { table: "tabela de rotas", ok: false },
    );
    return tracer.steps;
  }

  const firstArp = resolveArpInSegment(tracer, topology, index, sourceAttachment, nextHopIp, 1_000);
  if (!firstArp) return tracer.steps;

  if (!traceL2Frame(
    tracer,
    topology,
    index,
    sourceAttachment.end,
    firstArp.answered.end,
    sourceAttachment.vlan,
    source.mac,
    firstArp.mac,
    ETHERTYPE_IPV4,
    "pacote IPv4",
    2_000,
  )) {
    return tracer.steps;
  }

  // Destino é o próprio roteador (ping na interface) ou um host no segmento.
  if (firstArp.answered.kind === "host") {
    if (firstArp.answered.ip === dstIp) {
      tracer.add("L3", firstArp.answered.device, "recebe pacote", `ICMP echo request de ${source.ip}`, {
        detail: `TTL 64; entrega local`,
      });
    } else {
      tracer.add("L3", firstArp.answered.device, "recebe pacote", `destino ${dstIp} não é este host`, {
        ok: false,
      });
    }
    return tracer.steps;
  }

  if (firstArp.answered.ip === dstIp) {
    tracer.add("L3", firstArp.answered.device, "recebe pacote", `destino ${dstIp} é interface local`, {
      detail: "entrega local no roteador",
    });
    return tracer.steps;
  }

  let router = firstArp.answered.router!;
  let packet = buildIpv4Packet({
    src: source.ip,
    dst: dstIp,
    ttl: 64,
    protocol: PROTO_ICMP,
    payload,
    id: 7,
  });
  const detector = new LoopDetector(16, 2);
  let guard = 0;

  while (guard++ < 24) {
    const decision = routePacket(router, packet);
    const visit = detector.visit(`${router.name}->${decision.nextHop ?? dstIp}`);
    tracer.add("L3", router.name, `recebe pacote para ${dstIp}`, decision.reason, {
      table: "tabela de rotas",
      ttl: decision.ttl ?? packet.ttl,
      ok: decision.action !== "drop",
      detail: decision.route
        ? `rota ${routeToCidr(decision.route)} via ${decision.route.nextHop ?? "conectada"} dev ${
            decision.route.iface
          }`
        : undefined,
    });

    if (decision.action === "local") {
      tracer.add("L3", router.name, "entrega local", `${dstIp} pertence ao próprio roteador`, {
        detail: "fim do caminho L3",
      });
      return tracer.steps;
    }

    if (decision.action === "drop") {
      if (decision.icmp) {
        tracer.add(
          "L3",
          router.name,
          "gera ICMP",
          `ICMP type 11/time exceeded para ${source.ip}`,
          { table: "tabela de rotas", ok: false, detail: decision.reason },
        );
      }
      return tracer.steps;
    }

    if (visit.loop) {
      tracer.add("L3", router.name, "detecta loop", `loop de roteamento: ${visit.reason}`, {
        ok: false,
        detail: "pacote descartado para não consumir a rede",
      });
      return tracer.steps;
    }

    if (!decision.iface || !decision.iface.ip || !decision.nextHop) {
      tracer.add("L3", router.name, "encaminha", "interface/próximo salto inválido", { ok: false });
      return tracer.steps;
    }

    const egress = routerAttachment(router, decision.iface);
    egress.vlan = decision.iface.vlan ?? neighborVlan(topology, index, egress.end);
    const arp = resolveArpInSegment(tracer, topology, index, egress, decision.nextHop, 3_000 + guard * 100);
    if (!arp) return tracer.steps;

    if (!traceL2Frame(
      tracer,
      topology,
      index,
      egress.end,
      arp.answered.end,
      egress.vlan,
      router.interfaces.find((item) => item.name === decision.iface!.name)!.mac,
      arp.mac,
      ETHERTYPE_IPV4,
      "pacote IPv4",
      3_500 + guard * 100,
    )) {
      return tracer.steps;
    }

    if (arp.answered.kind === "host") {
      if (arp.answered.ip === dstIp) {
        tracer.add("L3", arp.answered.device, "recebe pacote", `ICMP echo request de ${source.ip}`, {
          detail: `TTL ${decision.ttl ?? packet.ttl}`,
        });
      } else {
        tracer.add("L3", arp.answered.device, "recebe pacote", `destino final ${dstIp} não alcançado`, {
          ok: false,
        });
      }
      return tracer.steps;
    }

    if (arp.answered.ip === dstIp) {
      tracer.add("L3", arp.answered.device, "recebe pacote", `destino ${dstIp} é interface local`, {
        detail: "entrega local no roteador",
      });
      return tracer.steps;
    }

    router = arp.answered.router!;
    packet = decision.packet!;
  }

  tracer.add("L3", router.name, "aborta", "limite de saltos do simulador atingido", { ok: false });
  return tracer.steps;
}

/** Maior TTL observado nos traces (útil para o CLI). */
export function minTtl(steps: TraceStep[]): number | null {
  const ttls = steps.filter((step) => step.ttl !== undefined).map((step) => step.ttl!);
  return ttls.length > 0 ? Math.min(...ttls) : null;
}
