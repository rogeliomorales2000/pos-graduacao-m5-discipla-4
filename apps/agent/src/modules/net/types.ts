/**
 * Tipos do simulador de redes.
 *
 * O modelo é intencionalmente simples: hosts, switches e roteadores são
 * descrições puras (serializáveis), e os algoritmos vivem nos módulos
 * `ip`, `ipv4`, `l2` e `l3`. Assim os laboratórios podem imprimir a
 * topologia sem depender de classes com estado escondido.
 */

/** Endereço IPv4 em notação pontuada (ex.: "192.168.0.1"). */
export type Ipv4 = string;

/** Endereço MAC em minúsculas separado por dois-pontos (ex.: "aa:bb:cc:00:11:22"). */
export type Mac = string;

/** EtherTypes usados no simulador. */
export const ETHERTYPE_IPV4 = 0x0800;
export const ETHERTYPE_ARP = 0x0806;
export const ETHERTYPE_VLAN = 0x8100;

/** Frame Ethernet II, opcionalmente com tag 802.1Q. */
export interface EthernetFrame {
  src: Mac;
  dst: Mac;
  etherType: number;
  payload: Uint8Array;
  /** VLAN 802.1Q. Ausente significa frame sem tag. */
  vlanId?: number;
  /** Prioridade 802.1p (0..7). */
  vlanPcp?: number;
  /** Drop Eligible Indicator. */
  vlanDei?: boolean;
}

/** Tabela ARP: IP -> MAC. */
export type ArpTable = Record<Ipv4, Mac>;

/** Entrada aprendida na tabela MAC de um switch. */
export interface MacTableEntry {
  mac: Mac;
  /** Porta de saída (id numérico da porta do switch). */
  port: number;
  /** VLAN em que o MAC foi observado (domínio de broadcast). */
  vlan: number;
  /** Instante lógico/real do aprendizado (ms). */
  learnedAt: number;
}

/** Rota da tabela de roteamento (CIDR). */
export interface RouteEntry {
  /** Endereço de rede, ex.: "10.1.0.0". */
  network: Ipv4;
  prefix: number;
  /** Próximo salto; null/ausente = rede diretamente conectada. */
  nextHop?: Ipv4 | null;
  /** Interface de saída. */
  iface: string;
  /** Métrica (usada apenas para desempate didático). */
  metric?: number;
  /** Origem da rota, só para narração. */
  kind?: "connected" | "static" | "default";
}

/** Host final: uma única interface, sem encaminhamento IP. */
export interface Host {
  name: string;
  mac: Mac;
  ip: Ipv4;
  prefix: number;
  /** Gateway padrão; null/ausente = host não roteia para fora da sub-rede. */
  gateway?: Ipv4 | null;
  /** VLAN de acesso (1 quando omitida). */
  vlan?: number;
}

/** Porta de switch com configuração de VLAN. */
export interface SwitchPort {
  id: number;
  mode: "access" | "trunk";
  /** VLAN de acesso (modo access). */
  vlan?: number;
  /** VLAN nativa do trunk (frames sem tag). */
  nativeVlan?: number;
  /** VLANs permitidas no trunk; ausente = todas. */
  allowedVlans?: number[];
  /** Custo STP simplificado (usado na eleição de portas). */
  cost?: number;
  /** Porta administrativamente desligada. */
  disabled?: boolean;
}

/** Switch Ethernet com tabela MAC e portas. */
export interface Switch {
  name: string;
  ports: SwitchPort[];
  macTable: MacTableEntry[];
  /** Bridge ID "prioridade.mac" (ex.: "32768.aa:bb:cc:dd:ee:01"). */
  bridgeId: string;
  /** Aging da tabela MAC em ms (padrão 300000). */
  macAgingMs?: number;
}

/** Interface (ou subinterface) de roteador. */
export interface RouterInterface {
  name: string;
  mac: Mac;
  ip: Ipv4 | null;
  prefix: number | null;
  /** VLAN da subinterface (router-on-a-stick). */
  vlan?: number;
  /** Interface física pai quando esta é uma subinterface. */
  parent?: string;
}

/** Roteador com interfaces, tabela de rotas e cache ARP. */
export interface Router {
  name: string;
  interfaces: RouterInterface[];
  routes: RouteEntry[];
  arpTable: ArpTable;
  /** Responde ARP em nome de destinos remotos (proxy ARP). */
  proxyArp?: boolean;
}

/** Extremidade de um link físico. */
export interface LinkEnd {
  device: string;
  /** 0 para host, id numérico para porta de switch, nome para interface de roteador. */
  port: number | string;
}

/** Cabo entre dois dispositivos. */
export interface Link {
  a: LinkEnd;
  b: LinkEnd;
  bandwidthMbps?: number;
  latencyMs?: number;
}

/** Topologia completa usada pelo simulador e pelos laboratórios. */
export interface Topology {
  name: string;
  hosts: Host[];
  switches: Switch[];
  routers: Router[];
  links: Link[];
  /** Nomes amigáveis das VLANs, apenas para exibição. */
  vlanNames?: Record<number, string>;
}

/** Passo narrado de uma simulação (uma decisão em um dispositivo). */
export interface TraceStep {
  index: number;
  /** Camada didática em que a decisão ocorreu. */
  layer: "L1" | "L2" | "L3" | "ARP" | "STP" | "L4+";
  /** Dispositivo que tomou a decisão. */
  device: string;
  /** O que estava acontecendo (ex.: "recebe frame", "consulta tabela MAC"). */
  action: string;
  /** Decisão tomada e sua justificativa. */
  decision: string;
  /** Tabela consultada/atualizada, quando houver. */
  table?: string;
  /** Detalhe livre (faixa de portas, CIDR, checksum etc.). */
  detail?: string;
  /** false indica descarte/erro. */
  ok?: boolean;
  /** TTL resultante quando o passo é de camada 3. */
  ttl?: number;
}
