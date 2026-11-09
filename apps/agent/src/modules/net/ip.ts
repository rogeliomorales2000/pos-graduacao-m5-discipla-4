/**
 * Matemática de IPv4 e CIDR.
 *
 * Todas as operações trabalham com inteiros de 32 bits sem sinal
 * (`>>> 0`). O objetivo é ser verificável: nada de bibliotecas externas e
 * nenhuma dependência de `net` do Node.
 */

import { Ipv4 } from "./types";

const OCTET = /^(0|[1-9][0-9]{0,2})$/;
const MAX_U32 = 0xffffffff;

export interface Cidr {
  /** IP exatamente como informado (pode ter bits de host). */
  ip: Ipv4;
  prefix: number;
  network: Ipv4;
  broadcast: Ipv4;
  mask: Ipv4;
  wildcard: Ipv4;
  firstHost: Ipv4;
  lastHost: Ipv4;
  /** Hosts utilizáveis (respeita /31 e /32 da RFC 3021). */
  hostCount: number;
  /** Total de endereços do bloco (2^(32-prefix)). */
  addressCount: number;
}

function assertU32(value: number, what: string): void {
  if (!Number.isInteger(value) || value < 0 || value > MAX_U32) {
    throw new Error(`${what} fora da faixa de 32 bits: ${value}`);
  }
}

/** Converte "a.b.c.d" em inteiro sem sinal. Rejeita zeros à esquerda. */
export function ipToInt(ip: Ipv4): number {
  const parts = ip.split(".");
  if (parts.length !== 4) {
    throw new Error(`IPv4 inválido (esperados 4 octetos): ${ip}`);
  }
  let value = 0;
  for (const part of parts) {
    if (!OCTET.test(part)) {
      throw new Error(`IPv4 inválido (octeto inválido): ${ip}`);
    }
    const octet = Number(part);
    if (octet > 255) throw new Error(`IPv4 inválido (octeto > 255): ${ip}`);
    value = (value * 256 + octet) >>> 0;
  }
  return value >>> 0;
}

/** Converte inteiro de 32 bits em "a.b.c.d". */
export function intToIp(value: number): Ipv4 {
  assertU32(value, "IPv4");
  const n = value >>> 0;
  return [n >>> 24, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join(".");
}

/** Aliases didáticos de parse/format. */
export const parseIpv4 = ipToInt;
export const formatIpv4 = intToIp;

export function isValidIpv4(value: unknown): value is Ipv4 {
  if (typeof value !== "string") return false;
  try {
    ipToInt(value);
    return true;
  } catch {
    return false;
  }
}

/** Máscara contígua em inteiro. prefix=0 produz 0.0.0.0. */
export function prefixToMaskInt(prefix: number): number {
  assertPrefix(prefix);
  if (prefix === 0) return 0;
  return (0xffffffff << (32 - prefix)) >>> 0;
}

export function prefixToMask(prefix: number): Ipv4 {
  return intToIp(prefixToMaskInt(prefix));
}

export function wildcard(prefix: number): Ipv4 {
  return intToIp((~prefixToMaskInt(prefix) & MAX_U32) >>> 0);
}

/** Converte uma máscara pontuada em prefixo, exigindo bits contíguos. */
export function maskToPrefix(mask: Ipv4): number {
  const value = ipToInt(mask);
  // Inverte e verifica se o resultado é da forma 0...01...1.
  const inverted = (~value & MAX_U32) >>> 0;
  if ((inverted & (inverted + 1)) !== 0) {
    throw new Error(`Máscara não contígua: ${mask}`);
  }
  let bits = 0;
  let v = value >>> 0;
  while (v !== 0) {
    bits += v & 1;
    v >>>= 1;
  }
  return bits;
}

function assertPrefix(prefix: number): void {
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    throw new Error(`Prefixo inválido: ${prefix}`);
  }
}

export function networkInt(ip: Ipv4, prefix: number): number {
  const mask = prefixToMaskInt(prefix);
  return (ipToInt(ip) & mask) >>> 0;
}

export function broadcastInt(ip: Ipv4, prefix: number): number {
  const mask = prefixToMaskInt(prefix);
  return ((ipToInt(ip) & mask) | (~mask & MAX_U32)) >>> 0;
}

export function networkAddress(ip: Ipv4, prefix: number): Ipv4 {
  return intToIp(networkInt(ip, prefix));
}

export function broadcastAddress(ip: Ipv4, prefix: number): Ipv4 {
  return intToIp(broadcastInt(ip, prefix));
}

/** Total de endereços do bloco. */
export function addressCount(prefix: number): number {
  assertPrefix(prefix);
  return 2 ** (32 - prefix);
}

/** Hosts utilizáveis: /32=1, /31=2 (RFC 3021), demais 2^n-2. */
export function hostCount(prefix: number): number {
  const total = addressCount(prefix);
  if (prefix >= 31) return total;
  return total - 2;
}

export function firstHostInt(ip: Ipv4, prefix: number): number {
  if (prefix >= 31) return networkInt(ip, prefix);
  return (networkInt(ip, prefix) + 1) >>> 0;
}

export function lastHostInt(ip: Ipv4, prefix: number): number {
  if (prefix >= 31) return broadcastInt(ip, prefix);
  return (broadcastInt(ip, prefix) - 1) >>> 0;
}

/** Aceita "a.b.c.d/p" ou "a.b.c.d" (prefixo /32). */
export function parseCidr(input: string): Cidr {
  const trimmed = input.trim();
  const slash = trimmed.indexOf("/");
  const ipText = slash === -1 ? trimmed : trimmed.slice(0, slash);
  const prefixText = slash === -1 ? "32" : trimmed.slice(slash + 1);
  if (!/^[0-9]{1,2}$/.test(prefixText)) {
    throw new Error(`Prefixo inválido em "${input}"`);
  }
  const prefix = Number(prefixText);
  assertPrefix(prefix);
  const ip = intToIp(ipToInt(ipText));
  return {
    ip,
    prefix,
    network: networkAddress(ip, prefix),
    broadcast: broadcastAddress(ip, prefix),
    mask: prefixToMask(prefix),
    wildcard: wildcard(prefix),
    firstHost: intToIp(firstHostInt(ip, prefix)),
    lastHost: intToIp(lastHostInt(ip, prefix)),
    hostCount: hostCount(prefix),
    addressCount: addressCount(prefix),
  };
}

export function isValidCidr(input: string): boolean {
  try {
    parseCidr(input);
    return true;
  } catch {
    return false;
  }
}

export function formatCidr(network: Ipv4, prefix: number): string {
  assertPrefix(prefix);
  return `${networkAddress(network, prefix)}/${prefix}`;
}

/** `ip` pertence ao bloco `cidr`? */
export function contains(cidr: string, ip: Ipv4): boolean {
  const block = parseCidr(cidr);
  const value = ipToInt(ip);
  return value >= ipToInt(block.network) && value <= ipToInt(block.broadcast);
}

/** Dois blocos CIDR se sobrepõem? */
export function overlaps(a: string, b: string): boolean {
  const left = parseCidr(a);
  const right = parseCidr(b);
  return (
    ipToInt(left.network) <= ipToInt(right.broadcast) &&
    ipToInt(right.network) <= ipToInt(left.broadcast)
  );
}

/** pertencem à mesma sub-rede segundo a máscara? */
export function sameSubnet(a: Ipv4, b: Ipv4, prefix: number): boolean {
  return networkInt(a, prefix) === networkInt(b, prefix);
}

/** Reduz o prefixo em `levels` bits (super-rede). */
export function supernet(cidr: string, levels = 1): string {
  if (!Number.isInteger(levels) || levels < 0) {
    throw new Error(`Níveis inválidos: ${levels}`);
  }
  const parsed = parseCidr(cidr);
  const prefix = Math.max(0, parsed.prefix - levels);
  return `${networkAddress(parsed.ip, prefix)}/${prefix}`;
}

/**
 * Sumariza rotas: une blocos sobrepostos/adjacentes e devolve a menor
 * lista de CIDRs que cobre exatamente as faixas de entrada.
 */
export function summarize(cidrs: string[]): string[] {
  if (cidrs.length === 0) return [];
  const ranges = cidrs
    .map((item) => {
      const parsed = parseCidr(item);
      return { start: ipToInt(parsed.network), end: ipToInt(parsed.broadcast) };
    })
    .sort((a, b) => a.start - b.start);

  const merged: Array<{ start: number; end: number }> = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end + 1) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }

  const result: string[] = [];
  for (const range of merged) {
    let start = range.start;
    while (start <= range.end) {
      const remaining = range.end - start + 1;
      // Maior bloco alinhado em `start` (start=0 permite /0).
      const alignment = start === 0 ? 2 ** 32 : (start & -start) >>> 0;
      let block = 1;
      while (block * 2 <= remaining && block * 2 <= alignment) block *= 2;
      const prefix = 32 - Math.round(Math.log2(block));
      result.push(`${intToIp(start)}/${prefix}`);
      start += block;
    }
  }
  return result;
}

/** Divide um bloco em sub-redes de prefixo maior (limite de 4096 saídas). */
export function subnets(cidr: string, newPrefix: number): string[] {
  const parsed = parseCidr(cidr);
  assertPrefix(newPrefix);
  if (newPrefix < parsed.prefix) {
    throw new Error(`Prefixo ${newPrefix} é menor que o bloco ${parsed.prefix}`);
  }
  const count = 2 ** (newPrefix - parsed.prefix);
  if (count > 4096) {
    throw new Error(`Divisão geraria ${count} sub-redes (limite 4096)`);
  }
  const step = 2 ** (32 - newPrefix);
  const base = ipToInt(parsed.network);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    out.push(`${intToIp(base + i * step)}/${newPrefix}`);
  }
  return out;
}

export interface VlsmBlock {
  /** Índice do pedido na lista original. */
  requestIndex: number;
  /** Hosts pedidos. */
  request: number;
  prefix: number;
  network: Ipv4;
  broadcast: Ipv4;
  firstHost: Ipv4;
  lastHost: Ipv4;
  /** Endereços utilizáveis do bloco. */
  usable: number;
  /** Endereços desperdiçados no bloco. */
  wasted: number;
}

/**
 * Aloca blocos VLSM do maior pedido para o menor.
 *
 * Cada pedido precisa de `hosts + 2` endereços (rede e broadcast); o bloco
 * é a menor potência de dois que atende. Isso reproduz o método clássico
 * ensinado em certificações: /24 com 50 hosts -> /26, e assim por diante.
 */
export function vlsmAllocate(baseCidr: string, sizes: number[]): VlsmBlock[] {
  const base = parseCidr(baseCidr);
  if (sizes.length === 0) throw new Error("Informe ao menos um tamanho de sub-rede");
  for (const size of sizes) {
    if (!Number.isInteger(size) || size < 1) {
      throw new Error(`Tamanho de sub-rede inválido: ${size}`);
    }
    if (size > 2 ** 32 - 2) {
      throw new Error(`Tamanho de sub-rede grande demais: ${size}`);
    }
  }

  const order = sizes
    .map((size, index) => ({ size, index }))
    .sort((a, b) => b.size - a.size || a.index - b.index);

  const baseStart = ipToInt(base.network);
  const baseEnd = ipToInt(base.broadcast);
  let cursor = 0;
  const allocated: VlsmBlock[] = [];

  for (const item of order) {
    let blockSize = 1;
    while (blockSize < item.size + 2) blockSize *= 2;
    const prefix = 32 - Math.round(Math.log2(blockSize));
    // Alinha o cursor ao tamanho do bloco.
    const aligned = Math.ceil(cursor / blockSize) * blockSize;
    const start = baseStart + aligned;
    const end = start + blockSize - 1;
    if (end > baseEnd) {
      throw new Error(
        `Sem espaço para ${item.size} hosts (${formatCidr(intToIp(start), prefix)}) em ${baseCidr}`,
      );
    }
    const usable = blockSize - 2;
    allocated.push({
      requestIndex: item.index,
      request: item.size,
      prefix,
      network: intToIp(start),
      broadcast: intToIp(end),
      firstHost: intToIp(start + 1),
      lastHost: intToIp(end - 1),
      usable,
      wasted: usable - item.size,
    });
    cursor = aligned + blockSize;
  }

  return allocated.sort((a, b) => ipToInt(a.network) - ipToInt(b.network));
}

/** Representação binária de um IPv4, útil no CLI didático. */
export function toBinary(ip: Ipv4, group = 8): string {
  const bits = ipToInt(ip).toString(2).padStart(32, "0");
  if (group <= 0) return bits;
  const parts: string[] = [];
  for (let i = 0; i < 32; i += group) parts.push(bits.slice(i, i + group));
  return parts.join(".");
}

/** Faixa privada RFC 1918? */
export function isPrivateIp(ip: Ipv4): boolean {
  return (
    contains("10.0.0.0/8", ip) ||
    contains("172.16.0.0/12", ip) ||
    contains("192.168.0.0/16", ip)
  );
}
