/**
 * Cabeçalho IPv4: construção, parsing, checksum RFC 1071, TTL e
 * fragmentação/reassembly.
 *
 * O cabeçalho gerado tem IHL=5 (20 bytes, sem opções). O parser aceita
 * opções (IHL > 5), pois o checksum cobre o cabeçalho inteiro.
 */

import { Ipv4 } from "./types";
import { intToIp, ipToInt } from "./ip";

export const IPV4_MIN_HEADER = 20;
export const IPV4_MAX_LENGTH = 65535;

export const PROTO_ICMP = 1;
export const PROTO_TCP = 6;
export const PROTO_UDP = 17;

export interface Ipv4Packet {
  version: number;
  /** Tamanho do cabeçalho em bytes (IHL * 4). */
  ihl: number;
  tos: number;
  totalLength: number;
  id: number;
  flags: { df: boolean; mf: boolean };
  /** Deslocamento do fragmento em bytes (múltiplo de 8). */
  fragmentOffset: number;
  ttl: number;
  protocol: number;
  checksum: number;
  src: Ipv4;
  dst: Ipv4;
  payload: Uint8Array;
  header: Uint8Array;
  raw: Uint8Array;
}

export interface BuildIpv4Options {
  src: Ipv4;
  dst: Ipv4;
  payload?: Uint8Array | string;
  ttl?: number;
  protocol?: number;
  id?: number;
  tos?: number;
  flags?: { df?: boolean; mf?: boolean };
  /** Em bytes; precisa ser múltiplo de 8. */
  fragmentOffset?: number;
}

function writeU16(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >>> 8) & 0xff;
  target[offset + 1] = value & 0xff;
}

function readU16(source: Uint8Array, offset: number): number {
  return ((source[offset] << 8) | source[offset + 1]) >>> 0;
}

function textToBytes(value: string | Uint8Array): Uint8Array {
  if (typeof value === "string") return new TextEncoder().encode(value);
  return value;
}

/**
 * Checksum de Internet (RFC 1071): soma em complemento de um de words de
 * 16 bits, com padding de zero no fim, e devolve o complemento.
 *
 * Propriedade usada nos testes: para um cabeçalho válido, com o campo de
 * checksum preenchido, `checksum(header) === 0`.
 */
export function checksum(data: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < data.length; i += 2) {
    const high = data[i] << 8;
    const low = i + 1 < data.length ? data[i + 1] : 0;
    sum += high | low;
  }
  while (sum >>> 16) {
    sum = (sum & 0xffff) + (sum >>> 16);
  }
  return (~sum) & 0xffff;
}

/** Monta um pacote IPv4 completo (cabeçalho + payload). */
export function buildIpv4Packet(options: BuildIpv4Options): Ipv4Packet {
  const payload = textToBytes(options.payload ?? new Uint8Array(0));
  const totalLength = IPV4_MIN_HEADER + payload.length;
  if (totalLength > IPV4_MAX_LENGTH) {
    throw new Error(`Pacote IPv4 grande demais: ${totalLength} bytes`);
  }
  const ttl = options.ttl ?? 64;
  if (!Number.isInteger(ttl) || ttl < 0 || ttl > 255) {
    throw new Error(`TTL inválido: ${ttl}`);
  }
  const id = options.id ?? 1;
  if (!Number.isInteger(id) || id < 0 || id > 0xffff) {
    throw new Error(`ID IPv4 inválido: ${id}`);
  }
  const protocol = options.protocol ?? PROTO_TCP;
  if (!Number.isInteger(protocol) || protocol < 0 || protocol > 255) {
    throw new Error(`Protocolo inválido: ${protocol}`);
  }
  const fragmentOffset = options.fragmentOffset ?? 0;
  if (!Number.isInteger(fragmentOffset) || fragmentOffset < 0 || fragmentOffset % 8 !== 0) {
    throw new Error(`Offset de fragmento inválido (múltiplo de 8): ${fragmentOffset}`);
  }
  if (fragmentOffset / 8 > 0x1fff) {
    throw new Error(`Offset de fragmento grande demais: ${fragmentOffset}`);
  }
  const df = options.flags?.df ?? false;
  const mf = options.flags?.mf ?? false;

  const raw = new Uint8Array(totalLength);
  raw[0] = 0x45; // versão 4, IHL 5
  raw[1] = (options.tos ?? 0) & 0xff;
  writeU16(raw, 2, totalLength);
  writeU16(raw, 4, id);
  const offsetUnits = fragmentOffset / 8;
  raw[6] = ((df ? 0x40 : 0) | (mf ? 0x20 : 0) | ((offsetUnits >>> 8) & 0x1f)) & 0xff;
  raw[7] = offsetUnits & 0xff;
  raw[8] = ttl;
  raw[9] = protocol;
  writeU16(raw, 10, 0); // checksum provisório
  raw.set(ipBytes(options.src), 12);
  raw.set(ipBytes(options.dst), 16);
  raw.set(payload, IPV4_MIN_HEADER);

  const header = raw.subarray(0, IPV4_MIN_HEADER);
  writeU16(raw, 10, checksum(header));
  return parseIpv4Packet(raw);
}

/** Converte um IPv4 em quatro octetos. */
function ipBytes(ip: Ipv4): Uint8Array {
  const n = ipToInt(ip);
  return new Uint8Array([n >>> 24, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

/** Lê um pacote IPv4 e valida tamanhos básicos. */
export function parseIpv4Packet(raw: Uint8Array): Ipv4Packet {
  if (raw.length < IPV4_MIN_HEADER) {
    throw new Error(`Pacote IPv4 truncado: ${raw.length} bytes`);
  }
  const version = raw[0] >>> 4;
  if (version !== 4) throw new Error(`Versão IPv4 inválida: ${version}`);
  const ihl = (raw[0] & 0x0f) * 4;
  if (ihl < IPV4_MIN_HEADER || ihl > raw.length) {
    throw new Error(`IHL inválido: ${ihl}`);
  }
  const totalLength = readU16(raw, 2);
  if (totalLength < ihl || totalLength > raw.length) {
    throw new Error(`Comprimento total inválido: ${totalLength} (buffer ${raw.length})`);
  }
  const flagsByte = raw[6];
  const fragmentOffset = ((flagsByte & 0x1f) * 256 + raw[7]) * 8;
  const header = raw.slice(0, ihl);
  return {
    version,
    ihl,
    tos: raw[1],
    totalLength,
    id: readU16(raw, 4),
    flags: { df: (flagsByte & 0x40) !== 0, mf: (flagsByte & 0x20) !== 0 },
    fragmentOffset,
    ttl: raw[8],
    protocol: raw[9],
    checksum: readU16(raw, 10),
    src: intToIp(readU16(raw, 12) * 65536 + readU16(raw, 14)),
    dst: intToIp(readU16(raw, 16) * 65536 + readU16(raw, 18)),
    payload: raw.slice(ihl, totalLength),
    header,
    raw: raw.slice(0, totalLength),
  };
}

/** true se o checksum do cabeçalho confere. */
export function verifyChecksum(packet: Ipv4Packet | Uint8Array): boolean {
  const header = packet instanceof Uint8Array ? packet.subarray(0, Math.min(packet.length, 20)) : packet.header;
  return checksum(header) === 0;
}

/**
 * Decrementa o TTL e recalcula o checksum. Lança erro se o TTL chegaria a
 * zero — quem chama deve gerar ICMP time exceeded.
 */
export function decrementTtl(packet: Ipv4Packet | Uint8Array, by = 1): Ipv4Packet {
  if (!Number.isInteger(by) || by < 1) throw new Error(`Decremento de TTL inválido: ${by}`);
  const parsed = packet instanceof Uint8Array ? parseIpv4Packet(packet) : packet;
  if (parsed.ttl <= by) {
    throw new Error(`TTL expirado (${parsed.ttl})`);
  }
  const raw = parsed.raw.slice();
  raw[8] = parsed.ttl - by;
  writeU16(raw, 10, 0);
  writeU16(raw, 10, checksum(raw.subarray(0, parsed.ihl)));
  return parseIpv4Packet(raw);
}

export interface FragmentOptions {
  /** MTU do enlace (cabeçalho + payload). */
  mtu: number;
}

/**
 * Fragmenta um pacote para caber em `mtu`.
 *
 * Regras aplicadas:
 *  - DF=true impede fragmentação (erro);
 *  - cada fragmento carrega múltiplo de 8 bytes, exceto o último;
 *  - MF=true em todos menos o último;
 *  - `fragmentOffset` em bytes, convertido para unidades de 8 no header;
 *  - todos compartilham o mesmo ID.
 */
export function fragment(
  packet: Ipv4Packet | Uint8Array,
  mtuOrOptions: number | FragmentOptions,
): Ipv4Packet[] {
  const parsed = packet instanceof Uint8Array ? parseIpv4Packet(packet) : packet;
  const mtu = typeof mtuOrOptions === "number" ? mtuOrOptions : mtuOrOptions.mtu;
  if (!Number.isInteger(mtu) || mtu < parsed.ihl + 8) {
    throw new Error(`MTU inválido para fragmentação: ${mtu}`);
  }
  if (parsed.flags.df) {
    throw new Error("DF=1: fragmentação proibida");
  }
  if (parsed.totalLength <= mtu) return [parsed];
  if (parsed.payload.length === 0) return [parsed];

  const capacity = Math.floor((mtu - parsed.ihl) / 8) * 8;
  if (capacity < 8) throw new Error(`MTU ${mtu} não comporta payload fragmentável`);

  const fragments: Ipv4Packet[] = [];
  for (let offset = 0; offset < parsed.payload.length; offset += capacity) {
    const chunk = parsed.payload.slice(offset, Math.min(offset + capacity, parsed.payload.length));
    const more = offset + chunk.length < parsed.payload.length;
    fragments.push(
      buildIpv4Packet({
        src: parsed.src,
        dst: parsed.dst,
        payload: chunk,
        ttl: parsed.ttl,
        protocol: parsed.protocol,
        id: parsed.id,
        tos: parsed.tos,
        flags: { df: false, mf: more },
        fragmentOffset: offset,
      }),
    );
  }
  return fragments;
}

/**
 * Remonta fragmentos IPv4. Valida mesma origem/destino/ID/protocolo,
 * offsets contíguos (sem buracos nem sobreposição) e último MF=false.
 */
export function reassemble(fragments: Array<Ipv4Packet | Uint8Array>): Ipv4Packet {
  if (fragments.length === 0) throw new Error("Nenhum fragmento informado");
  const parsed = fragments.map((item) =>
    item instanceof Uint8Array ? parseIpv4Packet(item) : item,
  );
  const first = parsed[0];
  for (const fragment of parsed) {
    if (
      fragment.src !== first.src ||
      fragment.dst !== first.dst ||
      fragment.id !== first.id ||
      fragment.protocol !== first.protocol
    ) {
      throw new Error("Fragmentos de pacotes diferentes (src/dst/id/protocolo)");
    }
  }

  const ordered = [...parsed].sort((a, b) => a.fragmentOffset - b.fragmentOffset);
  if (ordered[0].fragmentOffset !== 0) {
    throw new Error("Falta o primeiro fragmento (offset 0)");
  }

  let expected = 0;
  let totalPayload = 0;
  for (const fragment of ordered) {
    if (fragment.fragmentOffset !== expected) {
      throw new Error(
        `Fragmentos descontínuos: esperado offset ${expected}, recebido ${fragment.fragmentOffset}`,
      );
    }
    expected += fragment.payload.length;
    totalPayload += fragment.payload.length;
    if (fragment.payload.length % 8 !== 0 && fragment !== ordered[ordered.length - 1]) {
      throw new Error("Fragmento intermediário com tamanho não múltiplo de 8");
    }
  }
  const last = ordered[ordered.length - 1];
  if (last.flags.mf) {
    throw new Error("Reassembly incompleto: último fragmento com MF=1");
  }

  const payload = new Uint8Array(totalPayload);
  let cursor = 0;
  for (const fragment of ordered) {
    payload.set(fragment.payload, cursor);
    cursor += fragment.payload.length;
  }

  return buildIpv4Packet({
    src: first.src,
    dst: first.dst,
    payload,
    ttl: first.ttl,
    protocol: first.protocol,
    id: first.id,
    tos: first.tos,
    flags: { df: false, mf: false },
    fragmentOffset: 0,
  });
}

/** Nome do protocolo para narração. */
export function protocolName(protocol: number): string {
  switch (protocol) {
    case PROTO_ICMP:
      return "ICMP";
    case PROTO_TCP:
      return "TCP";
    case PROTO_UDP:
      return "UDP";
    default:
      return `IP/${protocol}`;
  }
}

export function packetToHex(packet: Ipv4Packet | Uint8Array): string {
  const raw = packet instanceof Uint8Array ? packet : packet.raw;
  return Array.from(raw, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export { ipBytes, ipToInt };
