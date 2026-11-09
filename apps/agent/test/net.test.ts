/**
 * Testes do módulo de redes.
 *
 * Cobre matemática de IPv4/CIDR, checksum RFC 1071, fragmentação,
 * switching/VLANs, longest-prefix match, TTL/ICMP, loop e sumarização.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  broadcastAddress,
  contains,
  formatCidr,
  hostCount,
  intToIp,
  ipToInt,
  isValidIpv4,
  maskToPrefix,
  networkAddress,
  overlaps,
  parseCidr,
  sameSubnet,
  summarize,
  supernet,
  vlsmAllocate,
  wildcard,
} from "../src/modules/net/ip";
import {
  PROTO_ICMP,
  buildIpv4Packet,
  checksum,
  decrementTtl,
  fragment,
  parseIpv4Packet,
  reassemble,
  verifyChecksum,
} from "../src/modules/net/ipv4";
import {
  MAC_BROADCAST,
  accessVlan,
  ageMacTable,
  buildFrame,
  decodeDot1q,
  electRootBridge,
  encodeDot1q,
  flushMacTable,
  learnMac,
  lookupMac,
  normalizeMac,
  spanningTree,
  switchFrame,
  tagFrame,
  untagFrame,
} from "../src/modules/net/l2";
import {
  ArpCache,
  LoopDetector,
  arpResolve,
  connectedRoutes,
  longestPrefixMatch,
  routePacket,
  routeToCidr,
} from "../src/modules/net/l3";
import { buildScenario, send } from "../src/modules/net/simulator";
import { Host, Mac, RouteEntry, Router, Switch, Topology } from "../src/modules/net/types";
import { getLab, LABS, listLabs } from "../src/modules/net/labs";

const macA = "02:00:00:00:00:0a";
const macB = "02:00:00:00:00:0b";
const macC = "02:00:00:00:00:0c";

/* ------------------------------------------------------------------ */
/* ip.ts                                                               */
/* ------------------------------------------------------------------ */

test("IPv4: parse/format e validação", () => {
  assert.equal(ipToInt("0.0.0.0"), 0);
  assert.equal(ipToInt("255.255.255.255"), 0xffffffff);
  assert.equal(ipToInt("192.168.1.1"), 3232235777);
  assert.equal(intToIp(3232235777), "192.168.1.1");
  assert.equal(isValidIpv4("10.0.0.1"), true);
  assert.equal(isValidIpv4("10.0.0.256"), false);
  assert.equal(isValidIpv4("10.0.0"), false);
  assert.equal(isValidIpv4("010.0.0.1"), false);
  assert.throws(() => ipToInt("1.2.3.4.5"));
});

test("CIDR /24: rede, broadcast, máscara e hosts", () => {
  const cidr = parseCidr("192.168.10.77/24");
  assert.equal(cidr.ip, "192.168.10.77");
  assert.equal(cidr.network, "192.168.10.0");
  assert.equal(cidr.broadcast, "192.168.10.255");
  assert.equal(cidr.mask, "255.255.255.0");
  assert.equal(cidr.wildcard, "0.0.0.255");
  assert.equal(cidr.firstHost, "192.168.10.1");
  assert.equal(cidr.lastHost, "192.168.10.254");
  assert.equal(cidr.hostCount, 254);
  assert.equal(cidr.addressCount, 256);
  assert.equal(networkAddress("192.168.10.77", 24), "192.168.10.0");
  assert.equal(broadcastAddress("192.168.10.77", 24), "192.168.10.255");
  assert.equal(wildcard(24), "0.0.0.255");
  assert.equal(maskToPrefix("255.255.255.0"), 24);
  assert.equal(maskToPrefix("255.255.255.252"), 30);
  assert.throws(() => maskToPrefix("255.0.255.0"));
});

test("CIDR /30, /31 e /32", () => {
  const c30 = parseCidr("10.0.0.5/30");
  assert.equal(c30.network, "10.0.0.4");
  assert.equal(c30.broadcast, "10.0.0.7");
  assert.equal(c30.firstHost, "10.0.0.5");
  assert.equal(c30.lastHost, "10.0.0.6");
  assert.equal(c30.hostCount, 2);
  assert.equal(c30.addressCount, 4);

  const c31 = parseCidr("10.0.0.4/31");
  assert.equal(c31.firstHost, "10.0.0.4");
  assert.equal(c31.lastHost, "10.0.0.5");
  assert.equal(c31.hostCount, 2);

  const c32 = parseCidr("10.0.0.9/32");
  assert.equal(c32.hostCount, 1);
  assert.equal(c32.firstHost, "10.0.0.9");
  assert.equal(hostCount(0), 2 ** 32 - 2);
});

test("CIDR: contains, overlaps e sameSubnet", () => {
  assert.equal(contains("192.168.10.0/24", "192.168.10.200"), true);
  assert.equal(contains("192.168.10.0/24", "192.168.11.1"), false);
  assert.equal(overlaps("192.168.0.0/23", "192.168.1.0/24"), true);
  assert.equal(overlaps("192.168.0.0/24", "192.168.2.0/24"), false);
  assert.equal(sameSubnet("192.168.1.10", "192.168.1.200", 24), true);
  assert.equal(sameSubnet("192.168.1.10", "192.168.2.10", 24), false);
  assert.equal(supernet("192.168.1.0/24", 1), "192.168.0.0/23");
  assert.equal(supernet("10.1.2.0/24", 4), "10.1.0.0/20");
});

test("sumarização: agrega blocos contíguos e preserva cobertura", () => {
  assert.deepEqual(summarize(["192.168.0.0/24", "192.168.1.0/24"]), ["192.168.0.0/23"]);
  assert.deepEqual(
    summarize(["172.16.0.0/24", "172.16.1.0/24", "172.16.2.0/24", "172.16.3.0/24"]),
    ["172.16.0.0/22"],
  );
  assert.deepEqual(summarize(["192.168.0.0/25", "192.168.0.128/25"]), ["192.168.0.0/24"]);
  assert.deepEqual(summarize(["10.0.0.0/8", "10.1.0.0/16"]), ["10.0.0.0/8"]);
  assert.deepEqual(summarize(["10.0.0.0/24", "10.0.2.0/24"]), ["10.0.0.0/24", "10.0.2.0/24"]);
  assert.deepEqual(summarize([]), []);
});

test("VLSM: aloca do maior para o menor com alinhamento correto", () => {
  const plan = vlsmAllocate("192.168.0.0/24", [50, 20, 10, 5]);
  assert.deepEqual(
    plan.map((block) => `${block.network}/${block.prefix}`),
    ["192.168.0.0/26", "192.168.0.64/27", "192.168.0.96/28", "192.168.0.112/29"],
  );
  assert.equal(plan[0].usable, 62);
  assert.equal(plan[0].wasted, 12);
  assert.equal(plan[1].broadcast, "192.168.0.95");
  assert.deepEqual(
    plan.map((block) => block.request),
    [50, 20, 10, 5],
  );
  assert.equal(formatCidr(plan[0].network, plan[0].prefix), "192.168.0.0/26");
  assert.throws(() => vlsmAllocate("192.168.0.0/24", [200, 100]), /Sem espaço/);
  assert.throws(() => vlsmAllocate("192.168.0.0/24", [0]), /inválido/);
});

/* ------------------------------------------------------------------ */
/* ipv4.ts                                                             */
/* ------------------------------------------------------------------ */

test("checksum RFC 1071: vetor conhecido e verificação", () => {
  // Cabeçalho clássico com o campo de checksum zerado.
  const zeroed = Uint8Array.from(
    Buffer.from("4500003c1c46400040060000ac100a63ac100a0c", "hex"),
  );
  assert.equal(checksum(zeroed), 0xb1e6);

  const valid = new Uint8Array(60);
  valid.set(Buffer.from("4500003c1c4640004006b1e6ac100a63ac100a0c", "hex"));
  const packet = parseIpv4Packet(valid);
  assert.equal(packet.checksum, 0xb1e6);
  assert.equal(verifyChecksum(packet), true);

  const corrupted = packet.raw.slice();
  corrupted[8] = 32; // altera TTL sem recalcular
  assert.equal(verifyChecksum(corrupted), false);
});

test("IPv4: build/parse e checksum de pacote novo", () => {
  const packet = buildIpv4Packet({
    src: "10.0.0.1",
    dst: "10.0.0.2",
    ttl: 64,
    protocol: PROTO_ICMP,
    payload: "ping",
    id: 0x1234,
  });
  assert.equal(packet.version, 4);
  assert.equal(packet.ihl, 20);
  assert.equal(packet.totalLength, 24);
  assert.equal(packet.id, 0x1234);
  assert.equal(packet.protocol, PROTO_ICMP);
  assert.equal(Buffer.from(packet.payload).toString("utf8"), "ping");
  assert.equal(verifyChecksum(packet), true);
});

test("TTL: decremento recalcula checksum e expira em zero", () => {
  const packet = buildIpv4Packet({ src: "10.0.0.1", dst: "10.0.0.2", ttl: 3 });
  const decremented = decrementTtl(packet);
  assert.equal(decremented.ttl, 2);
  assert.equal(verifyChecksum(decremented), true);
  assert.throws(() => decrementTtl(decremented, 2), /TTL expirado/);

  const expired = buildIpv4Packet({ src: "10.0.0.1", dst: "10.0.0.2", ttl: 1 });
  assert.throws(() => decrementTtl(expired), /TTL expirado/);
});

test("fragmentação: offsets, MF/DF e reassembly", () => {
  const payload = new Uint8Array(4000);
  for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
  const packet = buildIpv4Packet({
    src: "192.168.0.1",
    dst: "192.168.0.2",
    payload,
    ttl: 64,
    protocol: PROTO_ICMP,
    id: 99,
  });

  const fragments = fragment(packet, 1500);
  assert.equal(fragments.length, 3);
  assert.deepEqual(
    fragments.map((item) => item.fragmentOffset),
    [0, 1480, 2960],
  );
  assert.deepEqual(
    fragments.map((item) => item.flags.mf),
    [true, true, false],
  );
  assert.deepEqual(
    fragments.map((item) => item.flags.df),
    [false, false, false],
  );
  assert.deepEqual(
    fragments.map((item) => item.id),
    [99, 99, 99],
  );
  for (const item of fragments) {
    assert.equal(item.payload.length % 8 === 0 || !item.flags.mf, true);
    assert.equal(verifyChecksum(item), true);
  }

  const rebuilt = reassemble(fragments);
  assert.equal(rebuilt.totalLength, packet.totalLength);
  assert.deepEqual(rebuilt.payload, payload);
  assert.equal(rebuilt.flags.mf, false);
  assert.equal(rebuilt.fragmentOffset, 0);
  assert.equal(verifyChecksum(rebuilt), true);

  // MTU 576: capacidade de (576-20)/8*8 = 552 bytes por fragmento.
  const small = fragment(packet, 576);
  assert.equal(small[0].fragmentOffset, 0);
  assert.equal(small[1].fragmentOffset, 552);
  assert.deepEqual(reassemble(small).payload, payload);

  const df = buildIpv4Packet({
    src: "192.168.0.1",
    dst: "192.168.0.2",
    payload,
    flags: { df: true },
  });
  assert.throws(() => fragment(df, 1500), /DF=1/);

  // Fragmentos fora de ordem também remontam.
  assert.deepEqual(reassemble([...fragments].reverse()).payload, payload);
  assert.throws(() => reassemble([fragments[0], fragments[2]]), /descontínuos/);
});

/* ------------------------------------------------------------------ */
/* l2.ts                                                               */
/* ------------------------------------------------------------------ */

function testSwitch(): Switch {
  return {
    name: "sw1",
    bridgeId: "32768.02:00:00:00:00:01",
    macTable: [],
    macAgingMs: 10_000,
    ports: [
      { id: 1, mode: "access", vlan: 1 },
      { id: 2, mode: "access", vlan: 1 },
      { id: 3, mode: "access", vlan: 1 },
      { id: 4, mode: "access", vlan: 1 },
    ],
  };
}

test("MAC: normalização e formatos", () => {
  assert.equal(normalizeMac("AA-BB-CC-00-11-22"), "aa:bb:cc:00:11:22");
  assert.equal(normalizeMac("aabb.cc00.1122"), "aa:bb:cc:00:11:22");
  assert.throws(() => normalizeMac("aa:bb:cc"));
});

test("switch: aprende origem, inunda unknown e encaminha known unicast", () => {
  const sw = testSwitch();
  const broadcast = buildFrame({
    src: macA,
    dst: MAC_BROADCAST,
    etherType: 0x0800,
  });
  const flood = switchFrame(sw, broadcast, 1, 1_000);
  assert.equal(flood.action, "flood");
  assert.deepEqual(flood.egressPorts, [2, 3, 4]);
  assert.equal(lookupMac(sw, macA, 1, 1_000)?.port, 1);

  const unknown = buildFrame({ src: macB, dst: macA, etherType: 0x0800 });
  const forward = switchFrame(sw, unknown, 2, 2_000);
  assert.equal(forward.action, "forward");
  assert.deepEqual(forward.egressPorts, [1]);
  assert.equal(lookupMac(sw, macB, 1, 2_000)?.port, 2);

  const unknownDst = buildFrame({ src: macB, dst: macC, etherType: 0x0800 });
  const floodAgain = switchFrame(sw, unknownDst, 2, 3_000);
  assert.equal(floodAgain.action, "flood");
  assert.deepEqual(floodAgain.egressPorts, [1, 3, 4]);

  // Destino na mesma porta de ingresso é filtrado.
  const hairpin = buildFrame({ src: macB, dst: macA, etherType: 0x0800 });
  learnMac(sw, macC, 2, 1, 3_500);
  const filtered = switchFrame(sw, hairpin, 2, 3_600);
  assert.equal(filtered.action, "forward");
  assert.deepEqual(filtered.egressPorts, [1]);
  const selfFrame = buildFrame({ src: macC, dst: macC, etherType: 0x0800 });
  learnMac(sw, macC, 3, 1, 3_700);
  assert.equal(switchFrame(sw, selfFrame, 3, 3_800).action, "filter");
});

test("switch: aging remove entradas antigas", () => {
  const sw = testSwitch();
  learnMac(sw, macA, 1, 1, 1_000);
  assert.equal(lookupMac(sw, macA, 1, 5_000)?.port, 1);
  assert.equal(ageMacTable(sw, 11_001), 1);
  assert.equal(lookupMac(sw, macA, 1, 11_001), undefined);

  learnMac(sw, macB, 2, 1, 12_000);
  learnMac(sw, macC, 3, 1, 12_000);
  assert.equal(flushMacTable(sw, 2), 1);
  assert.equal(lookupMac(sw, macB, 1, 12_000), undefined);
  assert.equal(lookupMac(sw, macC, 1, 12_000)?.port, 3);
});

test("VLAN: isolamento, access/trunk e tags 802.1Q", () => {
  const sw: Switch = {
    name: "sw1",
    bridgeId: "32768.02:00:00:00:00:02",
    macTable: [],
    ports: [
      { id: 1, mode: "access", vlan: 10 },
      { id: 2, mode: "access", vlan: 20 },
      { id: 3, mode: "trunk", allowedVlans: [10, 20], nativeVlan: 1 },
      { id: 4, mode: "access", vlan: 10 },
    ],
  };

  const broadcast = buildFrame({ src: macA, dst: MAC_BROADCAST, etherType: 0x0800 });
  const decision = switchFrame(sw, broadcast, 1, 1_000);
  assert.equal(decision.vlan, 10);
  assert.deepEqual(decision.egressPorts, [3, 4]);
  assert.equal(decision.frames.find((item) => item.port === 3)?.frame.vlanId, 10);
  assert.equal(decision.frames.find((item) => item.port === 4)?.frame.vlanId, undefined);

  // Frame marcado em porta access é descartado.
  const taggedOnAccess = tagFrame(broadcast, 10);
  assert.equal(switchFrame(sw, taggedOnAccess, 1, 1_100).action, "drop");

  // VLAN não permitida no trunk é descartada.
  assert.equal(switchFrame(sw, tagFrame(broadcast, 30), 3, 1_200).action, "drop");

  // Ingresso no trunk com tag 20 -> só portas da VLAN 20, sem tag na saída access.
  const fromTrunk = switchFrame(sw, tagFrame(broadcast, 20), 3, 1_300);
  assert.equal(fromTrunk.vlan, 20);
  assert.deepEqual(fromTrunk.egressPorts, [2]);
  assert.equal(fromTrunk.frames[0].frame.vlanId, undefined);

  // Frame sem tag no trunk cai na VLAN nativa.
  const native = switchFrame(sw, broadcast, 3, 1_400);
  assert.equal(native.vlan, 1);
  assert.deepEqual(native.egressPorts, []);

  const dot1q = encodeDot1q({ pcp: 5, dei: true, vlanId: 100 });
  assert.deepEqual([...dot1q], [0x81, 0x00, 0xb0, 0x64]);
  assert.deepEqual(decodeDot1q(dot1q), { pcp: 5, dei: true, vlanId: 100 });
  assert.equal(untagFrame(tagFrame(broadcast, 10)).vlanId, undefined);
  assert.equal(accessVlan(sw.ports[0]), 10);
});

test("STP: menor bridge ID vence e portas redundantes são bloqueadas", () => {
  const switches: Switch[] = [
    { name: "sw1", bridgeId: "32768.02:00:00:00:00:01", macTable: [], ports: [{ id: 1, mode: "access", vlan: 1 }, { id: 2, mode: "access", vlan: 1 }, { id: 3, mode: "access", vlan: 1 }] },
    { name: "sw2", bridgeId: "32768.02:00:00:00:00:02", macTable: [], ports: [{ id: 1, mode: "access", vlan: 1 }, { id: 2, mode: "access", vlan: 1 }, { id: 3, mode: "access", vlan: 1 }] },
    { name: "sw3", bridgeId: "4096.02:00:00:00:00:03", macTable: [], ports: [{ id: 1, mode: "access", vlan: 1 }, { id: 2, mode: "access", vlan: 1 }, { id: 3, mode: "access", vlan: 1 }] },
  ];
  const links = [
    { a: { device: "sw1", port: 2 }, b: { device: "sw2", port: 2 } },
    { a: { device: "sw2", port: 3 }, b: { device: "sw3", port: 2 } },
    { a: { device: "sw3", port: 3 }, b: { device: "sw1", port: 3 } },
  ];
  assert.equal(electRootBridge(switches).root, "sw3");
  const tree = spanningTree(switches, links);
  assert.equal(tree.root, "sw3");
  const sw3Role = tree.roles.find((item) => item.name === "sw3")!;
  assert.equal(sw3Role.root, true);
  assert.equal(sw3Role.cost, 0);
  assert.equal(tree.roles.filter((item) => item.blockedPorts.length > 0).length, 1);
});

/* ------------------------------------------------------------------ */
/* l3.ts                                                               */
/* ------------------------------------------------------------------ */

const routeTable: RouteEntry[] = [
  { network: "0.0.0.0", prefix: 0, iface: "wan", nextHop: "203.0.113.1", kind: "default" },
  { network: "10.0.0.0", prefix: 8, iface: "a", nextHop: "10.0.0.1" },
  { network: "10.1.0.0", prefix: 16, iface: "b", nextHop: "10.0.0.2" },
  { network: "10.1.2.0", prefix: 24, iface: "c", nextHop: null },
  { network: "10.1.2.0", prefix: 24, iface: "d", nextHop: null, metric: 5 },
];

test("longest-prefix match escolhe o prefixo mais específico", () => {
  assert.equal(longestPrefixMatch(routeTable, "10.1.2.3")?.iface, "c");
  assert.equal(longestPrefixMatch(routeTable, "10.1.3.3")?.iface, "b");
  assert.equal(longestPrefixMatch(routeTable, "10.2.0.1")?.iface, "a");
  assert.equal(longestPrefixMatch(routeTable, "8.8.8.8")?.iface, "wan");
  assert.equal(longestPrefixMatch([], "8.8.8.8"), null);
  assert.equal(routeToCidr(routeTable[0]), "0.0.0.0/0");
});

test("ARP: resolução exata, proxy e falha", () => {
  const exact = arpResolve({ name: "h1", ip: "10.0.0.10", mac: macA }, "10.0.0.20", [
    { name: "h2", ip: "10.0.0.20", mac: macB },
  ]);
  assert.equal(exact.mac, macB);
  assert.equal(exact.viaProxy, false);
  assert.equal(exact.steps.length, 2);

  const proxy = arpResolve({ name: "h1", ip: "10.0.0.10", mac: macA }, "192.168.2.10", [
    { name: "r1", ip: "10.0.0.1", mac: macC, proxyFor: ["192.168.2.0/24"] },
  ]);
  assert.equal(proxy.mac, macC);
  assert.equal(proxy.viaProxy, true);

  const missing = arpResolve({ name: "h1", ip: "10.0.0.10", mac: macA }, "172.16.0.1", [
    { name: "h2", ip: "10.0.0.20", mac: macB },
  ]);
  assert.equal(missing.mac, null);
  assert.equal(missing.answeredBy, null);
});

test("ARP cache expira entradas", () => {
  const cache = new ArpCache({}, 1_000);
  cache.set("10.0.0.1", macA, 0);
  assert.equal(cache.get("10.0.0.1", 500), macA);
  assert.equal(cache.get("10.0.0.1", 1_001), null);
  cache.set("10.0.0.2", macB, 2_000);
  assert.equal(cache.size(), 1);
  assert.equal(cache.expire(3_001), 1);
  assert.equal(cache.size(), 0);
});

function testRouter(): Router {
  const router: Router = {
    name: "r1",
    arpTable: {},
    proxyArp: false,
    interfaces: [
      { name: "g0/0", mac: macA, ip: "10.0.0.1", prefix: 24 },
      { name: "g0/1", mac: macB, ip: "192.168.1.1", prefix: 24 },
    ],
    routes: [],
  };
  router.routes = [
    ...connectedRoutes(router),
    {
      network: "192.168.2.0",
      prefix: 24,
      nextHop: "10.0.0.2",
      iface: "g0/0",
      kind: "static",
    },
  ];
  return router;
}

test("roteamento: TTL decrementa, expira e gera ICMP time exceeded", () => {
  const router = testRouter();
  const packet = buildIpv4Packet({
    src: "192.168.1.10",
    dst: "192.168.2.10",
    ttl: 64,
    protocol: PROTO_ICMP,
  });
  const decision = routePacket(router, packet);
  assert.equal(decision.action, "forward");
  assert.equal(decision.nextHop, "10.0.0.2");
  assert.equal(decision.ttl, 63);
  assert.equal(decision.packet?.ttl, 63);
  assert.equal(verifyChecksum(decision.packet!), true);

  const expiring = buildIpv4Packet({
    src: "192.168.1.10",
    dst: "192.168.2.10",
    ttl: 1,
    protocol: PROTO_ICMP,
  });
  const dropped = routePacket(router, expiring);
  assert.equal(dropped.action, "drop");
  assert.ok(dropped.icmp);
  assert.equal(dropped.icmp!.payload[0], 11); // ICMP time exceeded
  assert.equal(dropped.icmp!.payload[1], 0);
  assert.equal(checksum(dropped.icmp!.payload), 0);
  assert.equal(dropped.icmp!.dst, "192.168.1.10");
  assert.equal(verifyChecksum(dropped.icmp!), true);

  const unreachable = routePacket(router, buildIpv4Packet({
    src: "192.168.1.10",
    dst: "203.0.113.9",
    ttl: 64,
    protocol: PROTO_ICMP,
  }));
  assert.equal(unreachable.action, "drop");
  assert.equal(unreachable.icmp?.payload[0], 3);
  assert.equal(checksum(unreachable.icmp!.payload), 0);

  const local = routePacket(router, buildIpv4Packet({
    src: "192.168.1.10",
    dst: "10.0.0.1",
    ttl: 64,
  }));
  assert.equal(local.action, "local");
});

test("loop detector dispara por repetição e por limite de saltos", () => {
  const detector = new LoopDetector(10, 2);
  assert.equal(detector.visit("r1->10.0.0.2").loop, false);
  assert.equal(detector.visit("r1->10.0.0.2").loop, false);
  assert.equal(detector.visit("r1->10.0.0.2").loop, true);

  const hopLimited = new LoopDetector(2, 99);
  assert.equal(hopLimited.visit("a").loop, false);
  assert.equal(hopLimited.visit("b").loop, false);
  assert.equal(hopLimited.visit("c").loop, true);
});

/* ------------------------------------------------------------------ */
/* simulator.ts                                                        */
/* ------------------------------------------------------------------ */

function assertDelivered(topology: Topology, src: string, dst: string): void {
  const steps = send(topology, src, dst);
  const failure = steps.find((step) => step.ok === false);
  assert.equal(failure, undefined, `passo com falha: ${failure?.device} ${failure?.decision}`);
  const last = steps[steps.length - 1];
  assert.equal(last.layer, "L3");
  assert.equal(last.device, dst);
}

test("simulador: switch único aprende MAC e encaminha known unicast", () => {
  const topology = buildScenario("single-switch");
  const steps = send(topology, "h1", "h2");
  assert.ok(steps.length > 5);
  assertDelivered(topology, "h1", "h2");
  assert.ok(
    steps.some(
      (step) =>
        step.device === "sw1" &&
        step.action.includes("pacote IPv4") &&
        step.decision.startsWith("forward"),
    ),
  );
  assert.equal(topology.switches[0].macTable.some((entry) => entry.mac === "02:00:00:00:00:12"), true);
});

test("simulador: VLANs isolam broadcast e impedem entrega entre VLANs", () => {
  const topology = buildScenario("vlans");
  assertDelivered(topology, "h1", "h2");
  const blocked = send(topology, "h1", "h3");
  assert.ok(blocked.some((step) => step.decision.includes("ARP sem resposta")));
  assert.ok(blocked.some((step) => step.ok === false));
  assert.equal(blocked.some((step) => step.device === "h3"), false);
});

test("simulador: router-on-a-stick roteia entre VLANs e decrementa TTL", () => {
  const topology = buildScenario("router-on-a-stick");
  const steps = send(topology, "h1", "h3");
  assertDelivered(topology, "h1", "h3");
  assert.ok(steps.some((step) => step.device === "r1" && step.ttl === 63));
  assert.ok(steps.some((step) => step.device === "sw1" && step.detail?.includes("VLAN 10")));
  assert.ok(steps.some((step) => step.device === "sw1" && step.detail?.includes("VLAN 20")));
});

test("simulador: rotas estáticas atravessam dois roteadores", () => {
  const topology = buildScenario("static-routes");
  const steps = send(topology, "h1", "h2");
  assertDelivered(topology, "h1", "h2");
  assert.ok(steps.some((step) => step.device === "r1" && step.decision.includes("192.168.2.0/24")));
  assert.ok(steps.some((step) => step.device === "r2" && step.ttl === 62));
});

test("simulador: loop de roteamento é detectado", () => {
  const topology = buildScenario("routing-loop");
  const steps = send(topology, "h1", "198.51.100.10");
  assert.ok(steps.some((step) => step.action.includes("detecta loop")));
  assert.ok(steps.some((step) => step.ok === false));
});

test("simulador: triângulo STP tem root determinístico", () => {
  const topology = buildScenario("stp");
  assert.equal(electRootBridge(topology.switches).root, "sw1");
  assertDelivered(topology, "h1", "h3");
});

/* ------------------------------------------------------------------ */
/* labs.ts                                                             */
/* ------------------------------------------------------------------ */

test("laboratórios: seis labs com topologia/passos/quiz e resposta válida", () => {
  assert.equal(LABS.length, 6);
  assert.deepEqual(
    listLabs().map((lab) => lab.id),
    ["switch", "vlans", "inter-vlan", "static-routes", "summarize", "vlsm"],
  );
  for (const summary of listLabs()) {
    const lab = getLab(summary.id);
    assert.ok(lab);
    assert.ok(lab!.objective.length > 20);
    assert.ok(lab!.expectedSteps.length >= 4);
    assert.ok(lab!.quiz.length >= 1);
    for (const question of lab!.quiz) {
      assert.ok(question.answer >= 0 && question.answer < question.options.length);
      assert.ok(question.explanation.length > 10);
    }
    if (lab!.topology) {
      assert.ok(lab!.topology.hosts.length > 0 || lab!.topology.routers.length > 0);
    }
  }
  assert.equal(getLab("inexistente"), undefined);
});

/* ------------------------------------------------------------------ */
/* Integração host -> switch -> host (sanity check dos tipos)          */
/* ------------------------------------------------------------------ */

test("topologia mínima montada à mão também funciona", () => {
  const hosts: Host[] = [
    { name: "a", mac: macA, ip: "172.16.0.10", prefix: 24, gateway: null },
    { name: "b", mac: macB, ip: "172.16.0.20", prefix: 24, gateway: null },
  ];
  const sw: Switch = {
    name: "sw",
    bridgeId: "32768.02:00:00:00:00:99",
    macTable: [],
    ports: [
      { id: 1, mode: "access", vlan: 1 },
      { id: 2, mode: "access", vlan: 1 },
    ],
  };
  const topology: Topology = {
    name: "manual",
    hosts,
    switches: [sw],
    routers: [],
    links: [
      { a: { device: "a", port: 0 }, b: { device: "sw", port: 1 } },
      { a: { device: "b", port: 0 }, b: { device: "sw", port: 2 } },
    ],
  };
  const steps = send(topology, "a", "b");
  assert.equal(steps.some((step) => step.ok === false), false);
  assert.equal(steps[steps.length - 1].device, "b");
  assert.equal(normalizeMac(macA), macA as Mac);
});
