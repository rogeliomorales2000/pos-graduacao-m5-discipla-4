#!/usr/bin/env node
/**
 * CLI do módulo de sistemas embarcados.
 *
 * Exemplos:
 *   tsx src/modules/embedded/cli.ts vid 0403:6001
 *   tsx src/modules/embedded/cli.ts usb "12 01 00 02 ..."
 *   tsx src/modules/embedded/cli.ts uart --baud 115200 --payload "AT\r\n"
 *   tsx src/modules/embedded/cli.ts can --clock 48000000 --bitrate 500000
 *   tsx src/modules/embedded/cli.ts modbus "01 03 00 00 00 0A"
 *   tsx src/modules/embedded/cli.ts android --steps
 *   tsx src/modules/embedded/cli.ts knox
 *   tsx src/modules/embedded/cli.ts protocols
 *
 * Comandos que alteram estado só mostram escrita com `--authorized`.
 */

import fs from "node:fs";
import { pathToFileURL } from "node:url";
import {
  adbCommands,
  authorizationChecklist,
  developerModeSteps,
  knoxGuardFacts,
  type AdbMode,
  type AndroidOs,
} from "./android";
import {
  COMMON_DEV_NODES,
  describeDeviceTree,
  deviceTreeExample,
  gpiodCommands,
  linuxDiagnostics,
  parseDeviceTree,
  systemdUnit,
  udevRule,
} from "./linux";
import {
  PROTOCOL_CATALOG,
  bleConnectionInterval,
  canBitTiming,
  describeProtocol,
  getProtocol,
  i2cAddress7to8,
  modbusCrcHex,
  modbusFrame,
  mqttRemainingLength,
  spiClock,
  uartFrame,
  type UartParity,
} from "./protocols";
import {
  decodeUsbClass,
  describeDevice,
  formatId,
  lookupVidPid,
  parseUsbDescriptors,
  vendorName,
} from "./usb";
import {
  comPortEnumeration,
  driverTestMode,
  pnpDiagnostics,
  pnputilCommands,
  winUsbInfTemplate,
  winUsbNotes,
} from "./windows";

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

const BOOLEAN_FLAGS = new Set([
  "authorized",
  "steps",
  "json",
  "enable",
  "disable",
  "help",
  "checklist",
  "all",
  "verbose",
]);

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const body = arg.slice(2);
      const equals = body.indexOf("=");
      if (equals >= 0) {
        flags[body.slice(0, equals)] = body.slice(equals + 1);
        continue;
      }
      if (BOOLEAN_FLAGS.has(body)) {
        flags[body] = true;
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[body] = next;
        i++;
      } else {
        flags[body] = true;
      }
      continue;
    }
    if (arg === "-h") {
      flags.help = true;
      continue;
    }
    positional.push(arg);
  }

  return { positional, flags };
}

function flagString(parsed: ParsedArgs, key: string): string | undefined {
  const value = parsed.flags[key];
  return typeof value === "string" ? value : undefined;
}

function flagNumber(parsed: ParsedArgs, key: string, fallback?: number): number | undefined {
  const raw = flagString(parsed, key);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`--${key} precisa ser numérico: "${raw}"`);
  return value;
}

function flagBool(parsed: ParsedArgs, key: string): boolean {
  const value = parsed.flags[key];
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return !["false", "0", "no", "nao", "não"].includes(value.toLowerCase());
  return false;
}

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

function parseAddress(raw: string | undefined): number {
  if (!raw) throw new Error("informe o endereço (ex.: 0x3c)");
  const value = raw.startsWith("0x") || raw.startsWith("0X")
    ? Number.parseInt(raw.slice(2), 16)
    : Number(raw);
  if (!Number.isFinite(value)) throw new Error(`endereço inválido: ${raw}`);
  return value;
}

function printHelp(): void {
  console.log([
    "M5 Agent — módulo de sistemas embarcados",
    "",
    "Uso: tsx src/modules/embedded/cli.ts <comando> [opções]",
    "",
    "Comandos:",
    "  vid <vid:pid>                 Consulta VID/PID na tabela local.",
    "  usb <hex...>                  Decodifica descritores USB (device + config).",
    "  uart --baud 115200 ...        Calcula quadro/tempo UART.",
    "  i2c <endereço>                Converte endereço I2C 7→8 bits.",
    "  spi --freq 48000000 --prescaler 8",
    "  can --clock 48000000 --bitrate 500000 [--sample 0.875]",
    "  modbus <hex...>               Calcula CRC-16/Modbus do quadro.",
    "  mqtt <n>                      Codifica remaining length (varint).",
    "  ble --interval 30             Valida intervalo de conexão BLE.",
    "  android [--steps] [--os samsung-knox] [--checklist]",
    "  adb [--authorized] [--mode read-only|diagnostics]",
    "  knox                          Fatos documentados sobre Knox Guard.",
    "  protocols [id]                Catálogo de protocolos.",
    "  dts [--file caminho.dts]      Interpreta device tree.",
    "  linux                         Nós /dev e diagnósticos Linux.",
    "  gpio <chip> <linha> [valor] [--authorized]",
    "  udev --vid 0403 --pid 6001 [--authorized]",
    "  systemd --name meu-servico --exec /usr/bin/app [--authorized]",
    "  windows                       Notas WinUSB, pnputil, COM e PnP.",
    "  driver-test --enable|--disable [--authorized]",
    "  checklist                     Checklist de autorização.",
    "",
    "Opções gerais: --authorized, --json, --help",
    "Sem --authorized, comandos de escrita são omitidos e explicados.",
  ].join("\n"));
}

function runVid(parsed: ParsedArgs): void {
  const raw = parsed.positional[0] ?? [flagString(parsed, "vid"), flagString(parsed, "pid")].filter(Boolean).join(":");
  if (!raw || !raw.includes(":")) throw new Error("uso: vid <vid:pid>, ex.: vid 0403:6001");
  const [vidRaw, pidRaw] = raw.split(":");
  if (!vidRaw || !pidRaw) throw new Error("VID e PID são obrigatórios");
  const entry = lookupVidPid(vidRaw, pidRaw);
  const vid = Number.parseInt(vidRaw.replace(/^0x/i, ""), 16);
  const pid = Number.parseInt(pidRaw.replace(/^0x/i, ""), 16);

  section(`VID:PID ${vidRaw}:${pidRaw}`);
  console.log(describeDevice({
    vid,
    pid,
    vendor: entry?.vendor,
    product: entry?.product,
  }));
  if (flagBool(parsed, "json")) console.log(`\nJSON: ${JSON.stringify(entry, null, 2)}`);
}

function runUsb(parsed: ParsedArgs): void {
  const hex = parsed.positional.join(" ");
  if (!hex.trim()) throw new Error("uso: usb \"12 01 00 02 ...\"");
  const descriptor = parseUsbDescriptors(hex);
  section("Descritor USB");
  console.log(describeDevice(descriptor));
  const cls = decodeUsbClass(
    descriptor.deviceClass,
    descriptor.deviceSubclass,
    descriptor.deviceProtocol,
  );
  console.log(`\nClasse do dispositivo: ${cls.label} — ${cls.detail}`);
  if (flagBool(parsed, "json")) console.log(`\nJSON: ${JSON.stringify(descriptor, null, 2)}`);
}

function runUart(parsed: ParsedArgs): void {
  const baud = flagNumber(parsed, "baud", 115200)!;
  const bits = flagNumber(parsed, "bits", 8)!;
  const parity = (flagString(parsed, "parity") ?? "none") as UartParity;
  const stop = flagNumber(parsed, "stop", 1)!;
  const payload = flagString(parsed, "payload")
    ?? (parsed.positional.length > 0 ? parsed.positional.join(" ") : "AT");
  const frame = uartFrame({ data: payload, baud, bits, parity, stop });

  section("UART");
  console.log(`Formato: ${frame.settings}`);
  console.log(`Payload: ${JSON.stringify(payload)} (${frame.bytes} byte[s])`);
  console.log(`Bits por quadro: ${frame.frameBits} (1 start + ${frame.dataBits} dados + ${frame.overheadBits - 1} overhead)`);
  console.log(`Bits totais: ${frame.totalBits}`);
  console.log(`Tempo por byte: ${frame.timePerByteMs.toFixed(4)} ms`);
  console.log(`Tempo total: ${frame.timeMs.toFixed(4)} ms`);
  console.log(`Overhead: ${frame.overheadPercent.toFixed(1)}%`);
  console.log(`Vazão efetiva de dados: ${frame.effectiveDataBps.toFixed(1)} bit/s`);
}

function runI2c(parsed: ParsedArgs): void {
  const address = parseAddress(parsed.positional[0] ?? flagString(parsed, "address"));
  const result = i2cAddress7to8(address);
  section("I2C 7→8 bits");
  console.log(`Endereço 7 bits: 0x${result.address7.toString(16).padStart(2, "0")}`);
  console.log(`Escrita: ${result.hexWrite} | Leitura: ${result.hexRead}`);
  console.log(`Utilizável: ${result.usable ? "sim" : "não"}`);
  if (result.warning) console.log(`Aviso: ${result.warning}`);
}

function runSpi(parsed: ParsedArgs): void {
  const freq = flagNumber(parsed, "freq", 48_000_000)!;
  const prescaler = flagNumber(parsed, "prescaler", 8)!;
  const result = spiClock({ freq, prescaler });
  section("SPI clock");
  console.log(`Entrada: ${result.inputHz} Hz`);
  console.log(`Prescaler: ${result.prescaler}`);
  console.log(`Saída: ${result.outputHz} Hz (${result.outputMHz.toFixed(3)} MHz)`);
  console.log(`Período: ${result.periodNs.toFixed(2)} ns`);
}

function runCan(parsed: ParsedArgs): void {
  const clockHz = flagNumber(parsed, "clock", 48_000_000)!;
  const bitrate = flagNumber(parsed, "bitrate", 500_000)!;
  const samplePoint = flagNumber(parsed, "sample", 0.875)!;
  const result = canBitTiming({ clockHz, bitrate, samplePoint });
  section("CAN bit timing");
  console.log(`Clock: ${result.clockHz} Hz | bitrate alvo: ${result.bitrate} bit/s`);
  console.log(`Prescaler: ${result.prescaler}`);
  console.log(`TQ por bit: ${result.tq} (sync=${result.syncSeg}, seg1=${result.seg1}, seg2=${result.seg2})`);
  console.log(`Sample point: ${(result.samplePoint * 100).toFixed(2)}% (alvo ${(result.samplePointRequested * 100).toFixed(2)}%)`);
  console.log(`Bitrate real: ${result.bitrateActual.toFixed(3)} bit/s`);
  console.log(`Erro: ${result.errorPct.toFixed(4)}%`);
  if (result.warning) console.log(`Aviso: ${result.warning}`);
}

function runModbus(parsed: ParsedArgs): void {
  const hex = parsed.positional.join(" ");
  if (!hex.trim()) throw new Error("uso: modbus \"01 03 00 00 00 0A\"");
  const frame = modbusFrame(hex);
  section("Modbus RTU CRC");
  console.log(`Payload: ${frame.payload.map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" ")}`);
  console.log(`CRC interno: 0x${frame.crc.toString(16).padStart(4, "0").toUpperCase()}`);
  console.log(`CRC no fio (low byte primeiro): ${modbusCrcHex(hex)}`);
  console.log(`Quadro completo: ${frame.hex}`);
}

function runMqtt(parsed: ParsedArgs): void {
  const raw = parsed.positional[0] ?? flagString(parsed, "length");
  if (raw === undefined) throw new Error("uso: mqtt <remaining-length>");
  const result = mqttRemainingLength(Number(raw));
  section("MQTT remaining length");
  console.log(`Valor: ${result.value}`);
  console.log(`Bytes: ${result.hex} (${result.length} byte[s])`);
}

function runBle(parsed: ParsedArgs): void {
  const intervalMs = flagNumber(parsed, "interval");
  const minMs = flagNumber(parsed, "min");
  const maxMs = flagNumber(parsed, "max");
  const latency = flagNumber(parsed, "latency", 0)!;
  const supervisionTimeoutMs = flagNumber(parsed, "timeout");
  const result = bleConnectionInterval({
    intervalMs,
    minMs,
    maxMs,
    latency,
    supervisionTimeoutMs,
  });
  section("BLE connection interval");
  console.log(`Intervalo: ${result.minMs} a ${result.maxMs} ms (unidades ${result.minUnits}..${result.maxUnits})`);
  console.log(`Latência: ${result.latency} eventos`);
  console.log(`Supervision timeout: ${result.supervisionTimeoutMs} ms (${result.supervisionTimeoutUnits} unidades)`);
  console.log(`Intervalo efetivo (pior caso): ${result.effectiveConnectionIntervalMs} ms`);
  console.log(`Nota: ${result.note}`);
}

function runAndroid(parsed: ParsedArgs): void {
  const os = (flagString(parsed, "os") ?? "android") as AndroidOs;
  if (os !== "android" && os !== "samsung-knox") {
    throw new Error(`--os inválido: ${os} (use android ou samsung-knox)`);
  }
  const guide = developerModeSteps(os);
  section(`Modo desenvolvedor — ${guide.os}`);
  guide.steps.forEach((step, index) => console.log(`${index + 1}. ${step}`));
  console.log("\nNotas:");
  guide.notes.forEach((note) => console.log(`- ${note}`));
  console.log("\nReferências:");
  guide.officialReferences.forEach((ref) => console.log(`- ${ref}`));

  if (flagBool(parsed, "checklist")) {
    section("Checklist de autorização");
    for (const item of authorizationChecklist()) {
      console.log(`[${item.required ? "obrigatório" : "recomendado"}] ${item.question}`);
      console.log(`  evidência: ${item.evidence}`);
    }
  }
}

function runAdb(parsed: ParsedArgs): void {
  const mode = (flagString(parsed, "mode") ?? "diagnostics") as AdbMode;
  if (mode !== "read-only" && mode !== "diagnostics") {
    throw new Error(`--mode inválido: ${mode} (use read-only ou diagnostics)`);
  }
  const commands = adbCommands({ authorized: flagBool(parsed, "authorized"), mode });
  section(`ADB — authorized=${commands.authorized} mode=${commands.mode}`);
  console.log("Somente leitura:");
  commands.readOnly.forEach((cmd) => console.log(`  ${cmd}`));
  console.log(`\nAlteram estado (${commands.stateChanging.length}):`);
  if (commands.stateChanging.length === 0) {
    console.log("  (nenhum — falta autorização ou modo read-only)");
  } else {
    commands.stateChanging.forEach((cmd) => console.log(`  ${cmd}`));
  }
  console.log("\nNão oferecidos:");
  commands.withheld.forEach((item) => console.log(`  - ${item}`));
  console.log("\nNotas:");
  commands.notes.forEach((note) => console.log(`  - ${note}`));
}

function runKnox(): void {
  const facts = knoxGuardFacts();
  section("Knox Guard — fatos documentados");
  console.log(`requiresConsent: ${facts.requiresConsent}`);
  console.log(facts.summary);
  console.log("\nFatos:");
  for (const fact of facts.facts) {
    console.log(`\n[${fact.id}] ${fact.statement}`);
    console.log(`  fonte: ${fact.source}`);
  }
  console.log("\nRemoção legítima:");
  facts.lawfulRemoval.forEach((item) => console.log(`  - ${item}`));
  console.log("\nImplicações legais:");
  facts.legalImplications.forEach((item) => console.log(`  - ${item}`));
  console.log("\nCanais oficiais:");
  facts.officialChannels.forEach((item) => console.log(`  - ${item}`));
  console.log("\nNão oferecido por este módulo:");
  facts.notProvided.forEach((item) => console.log(`  - ${item}`));
}

function runProtocols(parsed: ParsedArgs): void {
  const id = parsed.positional[0];
  if (!id) {
    section("Catálogo de protocolos");
    for (const spec of PROTOCOL_CATALOG) {
      console.log(`${spec.id.padEnd(12)} ${spec.name} (${spec.category})`);
    }
    console.log("\nUse `protocols <id>` para detalhes.");
    return;
  }
  const spec = getProtocol(id);
  if (!spec) {
    throw new Error(`protocolo não encontrado: ${id}. Disponíveis: ${PROTOCOL_CATALOG.map((p) => p.id).join(", ")}`);
  }
  section(spec.id);
  console.log(describeProtocol(spec));
}

function runDts(parsed: ParsedArgs): void {
  const file = flagString(parsed, "file") ?? parsed.positional[0];
  const source = file ? fs.readFileSync(file, "utf8") : deviceTreeExample();
  const root = parseDeviceTree(source);
  section("Device tree");
  if (file) console.log(`Arquivo: ${file}`);
  console.log(describeDeviceTree(root));
  console.log(`\nCompatíveis: ${collectCompatibleText(root)}`);
}

function collectCompatibleText(root: ReturnType<typeof parseDeviceTree>): string {
  const found = new Set<string>();
  const walk = (node: ReturnType<typeof parseDeviceTree>): void => {
    node.compatible.forEach((value) => found.add(value));
    node.children.forEach(walk);
  };
  walk(root);
  return Array.from(found).sort().join(", ") || "(nenhum)";
}

function runLinux(parsed: ParsedArgs): void {
  section("Nós /dev comuns");
  for (const node of COMMON_DEV_NODES) {
    console.log(`${node.path} — ${node.description}`);
    console.log(`  subsistema: ${node.subsystem} | permissões: ${node.permissions}`);
    if (node.notes) console.log(`  nota: ${node.notes}`);
  }
  section("Diagnóstico Linux (somente leitura)");
  for (const cmd of linuxDiagnostics()) {
    console.log(`${cmd.command}`);
    console.log(`  ${cmd.description}${cmd.needsRoot ? " (pode exigir root/CAP_SYSLOG)" : ""}`);
  }
}

function runGpio(parsed: ParsedArgs): void {
  const chip = parsed.positional[0] ?? flagString(parsed, "chip") ?? "gpiochip0";
  const line = parsed.positional[1] ?? flagString(parsed, "line") ?? "17";
  const value = Number(parsed.positional[2] ?? flagString(parsed, "value") ?? "1");
  if (value !== 0 && value !== 1) throw new Error("valor GPIO deve ser 0 ou 1");
  const result = gpiodCommands({
    chip,
    line,
    value,
    authorized: flagBool(parsed, "authorized"),
  });
  section("libgpiod");
  console.log("Somente leitura:");
  result.readOnly.forEach((cmd) => console.log(`  ${cmd}`));
  console.log("\nAlteram estado:");
  if (result.stateChanging.length === 0) console.log("  (nenhum — falta --authorized)");
  else result.stateChanging.forEach((cmd) => console.log(`  ${cmd}`));
  console.log("\nNotas:");
  result.notes.forEach((note) => console.log(`  - ${note}`));
}

function runUdev(parsed: ParsedArgs): void {
  const vid = flagString(parsed, "vid") ?? parsed.positional[0];
  const pid = flagString(parsed, "pid") ?? parsed.positional[1];
  if (!vid || !pid) throw new Error("uso: udev --vid 0403 --pid 6001 [--authorized]");
  const result = udevRule({
    authorized: flagBool(parsed, "authorized"),
    vendorId: vid,
    productId: pid,
    subsystem: (flagString(parsed, "subsystem") as "tty" | "usb" | "input" | "block" | undefined) ?? "tty",
    mode: flagString(parsed, "mode"),
    group: flagString(parsed, "group"),
    symlink: flagString(parsed, "symlink"),
    serial: flagString(parsed, "serial"),
  });
  section("Regra udev");
  console.log(result.content.trim());
  console.log(`\nInstalar: ${result.installCommand}`);
  console.log(`Verificar: ${result.verifyCommand}`);
  console.log(`Nota: ${result.note}`);
}

function runSystemd(parsed: ParsedArgs): void {
  const name = flagString(parsed, "name") ?? parsed.positional[0];
  const exec = flagString(parsed, "exec") ?? parsed.positional.slice(1).join(" ");
  if (!name || !exec) throw new Error("uso: systemd --name meu-servico --exec /usr/bin/app [--authorized]");
  const result = systemdUnit({
    authorized: flagBool(parsed, "authorized"),
    name,
    description: flagString(parsed, "description") ?? `M5 service ${name}`,
    execStart: exec,
    workdir: flagString(parsed, "workdir"),
    user: flagString(parsed, "user"),
    restart: (flagString(parsed, "restart") as "no" | "on-failure" | "always" | undefined) ?? "on-failure",
  });
  section(`systemd ${result.name}`);
  console.log(result.content.trim());
  console.log(`\nNota: ${result.note}`);
  if (result.installCommands.length) {
    console.log("\nInstalação (sudo):");
    result.installCommands.forEach((cmd) => console.log(`  ${cmd}`));
  }
}

function runWindows(parsed: ParsedArgs): void {
  section("WinUSB / drivers");
  winUsbNotes().forEach((note) => console.log(`- ${note}`));

  section("pnputil");
  const pnp = pnputilCommands({ authorized: flagBool(parsed, "authorized") });
  console.log("Somente leitura:");
  pnp.readOnly.forEach((cmd) => console.log(`  ${cmd.command}\n    ${cmd.description}`));
  console.log(`\nAlteram estado (${pnp.stateChanging.length}):`);
  if (pnp.stateChanging.length === 0) console.log("  (nenhum — falta --authorized)");
  else {
    pnp.stateChanging.forEach((cmd) => console.log(`  ${cmd.command}\n    ${cmd.description}`));
  }
  pnp.notes.forEach((note) => console.log(`\nNota: ${note}`));

  section("Portas COM (PowerShell)");
  comPortEnumeration().forEach((cmd) => console.log(`  ${cmd.command}\n    ${cmd.description}`));

  section("Diagnóstico PnP");
  pnpDiagnostics().forEach((cmd) => console.log(`  ${cmd.command}\n    ${cmd.description}`));

  if (flagBool(parsed, "json")) {
    console.log(`\nINF de exemplo:\n${winUsbInfTemplate({
      manufacturer: "M5",
      deviceName: "M5 USB Device",
      vid: "0403",
      pid: "6001",
    })}`);
  }
}

function runDriverTest(parsed: ParsedArgs): void {
  const enable = flagBool(parsed, "enable");
  const disable = flagBool(parsed, "disable");
  if (enable === disable) throw new Error("use --enable ou --disable (um dos dois)");
  const result = driverTestMode({ authorized: flagBool(parsed, "authorized"), enable });
  section(`testsigning — ${result.requested} (authorized=${result.authorized})`);
  console.log("Somente leitura:");
  result.readOnly.forEach((cmd) => console.log(`  ${cmd.command}\n    ${cmd.description}`));
  console.log(`\nAlteram estado (${result.stateChanging.length}):`);
  if (result.stateChanging.length === 0) console.log("  (nenhum — falta --authorized)");
  else result.stateChanging.forEach((cmd) => console.log(`  ${cmd.command}\n    ${cmd.description}`));
  console.log("\nAvisos:");
  result.warnings.forEach((warning) => console.log(`  - ${warning}`));
  console.log(`\nNota: ${result.note}`);
}

function runChecklist(): void {
  section("Checklist de autorização");
  for (const item of authorizationChecklist()) {
    console.log(`[${item.required ? "obrigatório" : "recomendado"}] ${item.question}`);
    console.log(`  evidência: ${item.evidence}`);
  }
}

export function run(argv: string[]): void {
  const command = argv[0];
  const parsed = parseArgs(argv.slice(1));

  if (!command || command === "help" || command === "--help" || flagBool(parsed, "help")) {
    printHelp();
    return;
  }

  switch (command) {
    case "vid":
      runVid(parsed);
      break;
    case "usb":
      runUsb(parsed);
      break;
    case "uart":
      runUart(parsed);
      break;
    case "i2c":
      runI2c(parsed);
      break;
    case "spi":
      runSpi(parsed);
      break;
    case "can":
      runCan(parsed);
      break;
    case "modbus":
      runModbus(parsed);
      break;
    case "mqtt":
      runMqtt(parsed);
      break;
    case "ble":
      runBle(parsed);
      break;
    case "android":
      runAndroid(parsed);
      break;
    case "adb":
      runAdb(parsed);
      break;
    case "knox":
      runKnox();
      break;
    case "protocols":
      runProtocols(parsed);
      break;
    case "dts":
      runDts(parsed);
      break;
    case "linux":
      runLinux(parsed);
      break;
    case "gpio":
      runGpio(parsed);
      break;
    case "udev":
      runUdev(parsed);
      break;
    case "systemd":
      runSystemd(parsed);
      break;
    case "windows":
      runWindows(parsed);
      break;
    case "driver-test":
      runDriverTest(parsed);
      break;
    case "checklist":
      runChecklist();
      break;
    default:
      throw new Error(`comando desconhecido: ${command}. Use --help.`);
  }
}

const entry = process.argv[1];
const isMain = entry !== undefined && import.meta.url === pathToFileURL(entry).href;

if (isMain) {
  try {
    run(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`erro: ${message}`);
    process.exitCode = 1;
  }
}
