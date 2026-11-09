/**
 * Testes do módulo de sistemas embarcados.
 *
 * Execute na raiz do repo:
 *   npx tsx --test apps/agent/test/embedded.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  adbCommands,
  authorizationChecklist,
  developerModeSteps,
  knoxGuardFacts,
} from "../src/modules/embedded/android";
import {
  collectCompatibles,
  describeDeviceTree,
  deviceTreeExample,
  findCompatible,
  gpiodCommands,
  linuxDiagnostics,
  parseDeviceTree,
  systemdUnit,
  udevRule,
} from "../src/modules/embedded/linux";
import {
  PROTOCOL_CATALOG,
  bleConnectionInterval,
  canBitTiming,
  describeProtocol,
  getProtocol,
  i2cAddress7to8,
  modbusCrc16,
  modbusCrcBytes,
  modbusCrcHex,
  modbusFrame,
  mqttRemainingLength,
  spiClock,
  uartFrame,
} from "../src/modules/embedded/protocols";
import {
  USB_DEVICE_TABLE,
  decodeUsbClass,
  describeDevice,
  lookupVidPid,
  parseUsbDescriptors,
  vendorName,
} from "../src/modules/embedded/usb";
import {
  comPortEnumeration,
  driverTestMode,
  pnpDiagnostics,
  pnputilCommands,
  winUsbInfTemplate,
  winUsbNotes,
} from "../src/modules/embedded/windows";

// Descritor real de um FT232R (0403:6001): device + configuration +
// interface vendor-specific + endpoint bulk IN. Formato little-endian.
const FTDI_FT232R_HEX = [
  "12 01 00 02 00 00 00 40 03 04 01 60 00 06 01 02 03 01",
  "09 02 12 00 01 01 00 80 32",
  "09 04 00 00 01 ff ff ff 02",
  "07 05 81 02 40 00 00",
].join(" ");

test("tabela VID/PID tem pelo menos 40 pares e lookup por string/número", () => {
  assert.ok(USB_DEVICE_TABLE.length >= 40, `tabela tem ${USB_DEVICE_TABLE.length} pares`);

  const ftdi = lookupVidPid("0403", "6001");
  assert.ok(ftdi);
  assert.equal(ftdi.vendor, "FTDI");
  assert.match(ftdi.product, /FT232R/);

  const same = lookupVidPid(0x0403, 0x6001);
  assert.equal(same?.product, ftdi.product);

  assert.equal(lookupVidPid("ffff", "ffff"), null);
  assert.equal(vendorName(0x2341), "Arduino");
  assert.match(vendorName(0x1234), /Desconhecido/);
});

test("parseUsbDescriptors decodifica descritor real do FT232R", () => {
  const descriptor = parseUsbDescriptors(FTDI_FT232R_HEX);

  assert.equal(descriptor.bLength, 18);
  assert.equal(descriptor.bDescriptorType, 0x01);
  assert.equal(descriptor.bcdUSB, 0x0200);
  assert.equal(descriptor.maxPacketSize0, 64);
  assert.equal(descriptor.idVendor, 0x0403);
  assert.equal(descriptor.idProduct, 0x6001);
  assert.equal(descriptor.bcdDevice, 0x0600);
  assert.equal(descriptor.numConfigurations, 1);
  assert.equal(descriptor.iManufacturer, 1);
  assert.equal(descriptor.iProduct, 2);
  assert.equal(descriptor.iSerialNumber, 3);

  const config = descriptor.configuration;
  assert.ok(config);
  assert.equal(config.value, 1);
  assert.equal(config.numInterfaces, 1);
  assert.equal(config.maxPowermA, 100);
  assert.equal(config.selfPowered, false);
  assert.equal(config.remoteWakeup, false);
  assert.equal(config.interfaces.length, 1);

  const iface = config.interfaces[0]!;
  assert.equal(iface.classCode, 0xff);
  assert.equal(iface.subclassCode, 0xff);
  assert.equal(iface.protocolCode, 0xff);
  assert.equal(iface.endpoints.length, 1);

  const endpoint = iface.endpoints[0]!;
  assert.equal(endpoint.address, 0x81);
  assert.equal(endpoint.number, 1);
  assert.equal(endpoint.direction, "in");
  assert.equal(endpoint.transferType, "bulk");
  assert.equal(endpoint.maxPacketSize, 64);

  assert.match(describeDevice(descriptor), /FT232R/);
  assert.match(describeDevice({ vid: 0x0403, pid: 0x6001 }), /FTDI/);
});

test("decodeUsbClass identifica CDC ACM, HID e Android ADB", () => {
  assert.match(decodeUsbClass(0x02, 0x02, 0x01).detail, /ACM/);
  assert.match(decodeUsbClass(0x03, 0x01, 0x01).detail, /teclado/);
  assert.match(decodeUsbClass(0xff, 0x42, 0x01).detail, /ADB/);
  assert.match(decodeUsbClass(0xe0, 0x01, 0x01).detail, /Bluetooth/);
  assert.equal(decodeUsbClass(0x08, 0x06, 0x50).label, "Mass Storage");
});

test("parseUsbDescriptors rejeita entrada inválida", () => {
  assert.throws(() => parseUsbDescriptors("12 01"), /18 bytes/);
  assert.throws(() => parseUsbDescriptors("12 02 00 02 00 00 00 40 03 04 01 60 00 06 01 02 03 01"), /bDescriptorType/);
});

test("CRC-16/Modbus confere com o vetor 01 03 00 00 00 0A => C5 CD", () => {
  const frame = [0x01, 0x03, 0x00, 0x00, 0x00, 0x0a];

  // Valor interno do algoritmo (init 0xFFFF, polinômio refletido 0xA001).
  assert.equal(modbusCrc16(frame), 0xcdc5);
  // No fio o low byte vai primeiro: C5 CD.
  assert.deepEqual(modbusCrcBytes(frame), [0xc5, 0xcd]);
  assert.equal(modbusCrcHex(frame), "C5 CD");

  const full = modbusFrame(frame);
  assert.equal(full.hex, "01 03 00 00 00 0A C5 CD");
  assert.equal(modbusCrcHex("01 03 00 00 00 0A"), "C5 CD");
});

test("MQTT remaining length usa varint de 7 bits", () => {
  assert.deepEqual(mqttRemainingLength(0).bytes, [0x00]);
  assert.deepEqual(mqttRemainingLength(127).bytes, [0x7f]);
  assert.deepEqual(mqttRemainingLength(128).bytes, [0x80, 0x01]);
  assert.deepEqual(mqttRemainingLength(16383).bytes, [0xff, 0x7f]);
  assert.deepEqual(mqttRemainingLength(268_435_455).bytes, [0xff, 0xff, 0xff, 0x7f]);
  assert.equal(mqttRemainingLength(128).hex, "80 01");
  assert.throws(() => mqttRemainingLength(268_435_456), /inválido/);
  assert.throws(() => mqttRemainingLength(-1), /inválido/);
});

test("CAN bit timing fica dentro de 1% de erro em 48 MHz / 500 kbit/s", () => {
  const result = canBitTiming({ clockHz: 48_000_000, bitrate: 500_000, samplePoint: 0.875 });

  assert.ok(result.errorPct < 1, `erro ${result.errorPct}%`);
  assert.equal(result.prescaler, 6);
  assert.equal(result.tq, 16);
  assert.equal(result.syncSeg + result.seg1 + result.seg2, result.tq);
  assert.equal(result.bitrateActual, 500_000);
  assert.ok(Math.abs(result.samplePoint - 0.875) < 0.01);
  assert.match(String(result.seg1), /^\d+$/);

  const other = canBitTiming({ clockHz: 16_000_000, bitrate: 250_000, samplePoint: 0.875 });
  assert.ok(other.errorPct < 1);
  assert.equal(other.bitrateActual, 250_000);
});

test("adbCommands não devolve escrita nem root quando authorized=false", () => {
  const denied = adbCommands({ authorized: false, mode: "diagnostics" });
  assert.equal(denied.authorized, false);
  assert.equal(denied.stateChanging.length, 0);
  assert.ok(denied.readOnly.length > 0);

  const executable = [...denied.readOnly, ...denied.stateChanging].join("\n");
  assert.doesNotMatch(executable, /\badb\s+root\b/i);
  assert.doesNotMatch(executable, /\badb\s+shell\s+su\b/i);
  assert.doesNotMatch(executable, /fastboot/i);
  assert.match(denied.notes.join(" "), /authorized=false/);

  const allowed = adbCommands({ authorized: true, mode: "diagnostics" });
  assert.ok(allowed.stateChanging.length > 0);
  const allowedExecutable = [...allowed.readOnly, ...allowed.stateChanging].join("\n");
  assert.doesNotMatch(allowedExecutable, /\badb\s+root\b/i);
  assert.doesNotMatch(allowedExecutable, /\badb\s+shell\s+su\b/i);

  const readonlyMode = adbCommands({ authorized: true, mode: "read-only" });
  assert.equal(readonlyMode.stateChanging.length, 0);
});

test("knoxGuardFacts exige consentimento e documenta remoção legítima", () => {
  const facts = knoxGuardFacts();
  assert.equal(facts.requiresConsent, true);
  assert.ok(facts.facts.length >= 5);
  assert.ok(facts.facts.some((fact) => fact.id === "removal"));
  assert.ok(facts.lawfulRemoval.length >= 3);
  assert.ok(facts.legalImplications.length >= 3);
  assert.ok(facts.notProvided.join(" ").toLowerCase().includes("bypass"));
  assert.match(facts.summary, /Knox Guard/);
});

test("developerModeSteps documenta os 7 toques e o caminho Samsung", () => {
  const android = developerModeSteps("android");
  const text = android.steps.join("\n");
  assert.match(text, /7 vezes/);
  assert.match(text, /Número da versão/);
  assert.match(text, /Depuração USB/);

  const knox = developerModeSteps("samsung-knox");
  assert.ok(knox.notes.some((note) => note.includes("Knox Guard")));
  assert.ok(knox.notes.some((note) => note.includes("MDM")));
});

test("checklist de autorização cobre propriedade, escopo, backup e legalidade", () => {
  const ids = authorizationChecklist().map((item) => item.id);
  assert.ok(ids.includes("ownership"));
  assert.ok(ids.includes("scope"));
  assert.ok(ids.includes("backup"));
  assert.ok(ids.includes("legal"));
});

test("uartFrame calcula 8N1, tempo e overhead", () => {
  const result = uartFrame({
    data: "1234567890",
    baud: 115200,
    bits: 8,
    parity: "none",
    stop: 1,
  });

  assert.equal(result.bytes, 10);
  assert.equal(result.frameBits, 10);
  assert.equal(result.totalBits, 100);
  assert.equal(result.overheadBits, 2);
  assert.equal(result.overheadPercent, 25);
  assert.ok(Math.abs(result.timeMs - 0.8680555) < 0.0001);
  assert.ok(Math.abs(result.effectiveDataBps - 92160) < 0.01);

  const even = uartFrame({ data: "A", baud: 9600, bits: 8, parity: "even", stop: 1 });
  assert.equal(even.frameBits, 11);
  assert.throws(() => uartFrame({ data: "A", baud: 9600, bits: 10 }), /bits/);
  assert.throws(() => uartFrame({ data: "A", baud: 0 }), /baud/);
});

test("i2cAddress7to8 converte 0x3C em escrita 0x78 e leitura 0x79", () => {
  const result = i2cAddress7to8(0x3c);
  assert.equal(result.write, 0x78);
  assert.equal(result.read, 0x79);
  assert.equal(result.hexWrite, "0x78");
  assert.equal(result.hexRead, "0x79");
  assert.equal(result.usable, true);
  assert.equal(result.warning, undefined);

  const reserved = i2cAddress7to8(0x00);
  assert.equal(reserved.usable, false);
  assert.ok(reserved.warning);
  assert.throws(() => i2cAddress7to8(0x80), /inválido/);
});

test("spiClock divide o clock pelo prescaler", () => {
  const result = spiClock({ freq: 48_000_000, prescaler: 8 });
  assert.equal(result.outputHz, 6_000_000);
  assert.equal(result.outputMHz, 6);
  assert.ok(Math.abs(result.periodNs - 166.666) < 0.1);
  assert.throws(() => spiClock({ freq: 0, prescaler: 1 }), /frequência/);
});

test("bleConnectionInterval converte para unidades de 1,25 ms e valida timeout", () => {
  const result = bleConnectionInterval({ intervalMs: 30, latency: 0 });
  assert.equal(result.minUnits, 24);
  assert.equal(result.maxUnits, 24);
  assert.equal(result.minMs, 30);
  assert.ok(result.supervisionTimeoutMs > 30 * 2);
  assert.throws(() => bleConnectionInterval({ intervalMs: 5 }), /faixa/);
  assert.throws(
    () => bleConnectionInterval({ intervalMs: 30, latency: 0, supervisionTimeoutMs: 50 }),
    /supervision/,
  );
});

test("catálogo de protocolos cobre os 10 protocolos pedidos", () => {
  const ids = PROTOCOL_CATALOG.map((spec) => spec.id);
  for (const id of ["uart", "i2c", "spi", "can", "modbus-rtu", "mqtt", "ble-gatt", "usb-cdc", "jtag-swd", "rs-485"]) {
    assert.ok(ids.includes(id), `faltou ${id}`);
  }
  assert.ok(PROTOCOL_CATALOG.length >= 10);
  for (const spec of PROTOCOL_CATALOG) {
    assert.ok(spec.physical.length > 10);
    assert.ok(Object.keys(spec.timing).length > 0);
    assert.ok(spec.references.length > 0);
  }
  assert.equal(getProtocol("UART")?.id, "uart");
  assert.match(describeProtocol(getProtocol("modbus-rtu")!), /CRC-16/);
});

test("parseDeviceTree interpreta nós, propriedades e compatíveis", () => {
  const tree = parseDeviceTree(deviceTreeExample());
  assert.equal(tree.name, "/");
  assert.ok(tree.compatible.includes("m5,dev-board"));

  const uart = findCompatible(tree, "snps,dw-apb-uart");
  assert.ok(uart);
  assert.equal(uart.name, "serial");
  assert.equal(uart.unitAddress, "10000000");
  assert.equal(uart.label, "uart0");
  assert.equal(uart.properties["clock-frequency"], "<48000000>");

  const sensor = findCompatible(tree, "ti,tmp102");
  assert.ok(sensor);
  assert.equal(sensor.unitAddress, "48");

  const compatibles = collectCompatibles(tree);
  assert.ok(compatibles.includes("simple-bus"));
  assert.ok(compatibles.includes("snps,designware-i2c"));
  assert.match(describeDeviceTree(tree), /uart0: serial@10000000/);
});

test("udevRule gera regra correta e bloqueia instalação sem autorização", () => {
  const denied = udevRule({ authorized: false, vendorId: "0403", productId: "6001" });
  assert.equal(denied.requiresSudo, true);
  assert.match(denied.content, /ATTRS\{idVendor\}=="0403"/);
  assert.match(denied.content, /ATTRS\{idProduct\}=="6001"/);
  assert.match(denied.installCommand, /BLOQUEADO/);
  assert.match(denied.note, /Somente leitura/);

  const allowed = udevRule({
    authorized: true,
    vendorId: 0x0403,
    productId: 0x6001,
    symlink: "ttyM5",
  });
  assert.match(allowed.installCommand, /^sudo install/);
  assert.match(allowed.installCommand, /udevadm control --reload-rules/);
  assert.match(allowed.verifyCommand, /udevadm info/);
});

test("systemdUnit só devolve comandos de instalação com autorização", () => {
  const denied = systemdUnit({
    name: "m5-diag",
    description: "Diagnóstico M5",
    execStart: "/usr/bin/m5-diag --watch",
  });
  assert.equal(denied.installCommands.length, 0);
  assert.match(denied.content, /ExecStart=\/usr\/bin\/m5-diag --watch/);
  assert.match(denied.content, /NoNewPrivileges=true/);
  assert.match(denied.note, /Somente leitura/);

  const allowed = systemdUnit({
    authorized: true,
    name: "m5-diag",
    description: "Diagnóstico M5",
    execStart: "/usr/bin/m5-diag --watch",
  });
  assert.ok(allowed.installCommands.some((cmd) => cmd.includes("systemctl enable --now")));
  assert.throws(
    () => systemdUnit({ name: "x", description: "x\nInjected=1", execStart: "/bin/true" }),
    /quebra de linha/,
  );
});

test("gpiodCommands mantém leitura e só escreve com autorização", () => {
  const denied = gpiodCommands({ chip: "gpiochip0", line: 17 });
  assert.ok(denied.readOnly.includes("gpioinfo gpiochip0"));
  assert.equal(denied.stateChanging.length, 0);

  const allowed = gpiodCommands({ authorized: true, chip: "gpiochip0", line: 17, value: 1 });
  assert.deepEqual(allowed.stateChanging, ["gpioset gpiochip0 17=1"]);
});

test("linuxDiagnostics inclui dmesg, lsusb e lsblk somente-leitura", () => {
  const commands = linuxDiagnostics();
  const text = commands.map((cmd) => cmd.command).join("\n");
  assert.match(text, /dmesg/);
  assert.match(text, /lsusb -t/);
  assert.match(text, /lsblk -o/);
  assert.ok(commands.every((cmd) => cmd.readOnly));
});

test("pnputilCommands devolve somente leitura sem autorização", () => {
  const denied = pnputilCommands();
  assert.ok(denied.readOnly.some((cmd) => cmd.command === "pnputil /enum-devices /connected"));
  assert.equal(denied.stateChanging.length, 0);

  const allowed = pnputilCommands({
    authorized: true,
    infPath: ".\\meu-driver.inf",
    deviceId: "USB\\VID_0403&PID_6001\\SERIAL",
  });
  const text = allowed.stateChanging.map((cmd) => cmd.command).join("\n");
  assert.match(text, /\/add-driver "\.\\meu-driver\.inf" \/install/);
  assert.match(text, /\/restart-device "USB\\VID_0403&PID_6001\\SERIAL"/);
  assert.match(text, /\/delete-driver oem42\.inf \/uninstall \/force/);
});

test("enumeração de COM e PnP usa PowerShell correto", () => {
  const com = comPortEnumeration().map((cmd) => cmd.command).join("\n");
  assert.match(com, /Get-CimInstance Win32_SerialPort/);
  assert.match(com, /\[System\.IO\.Ports\.SerialPort\]::GetPortNames\(\)/);
  assert.match(com, /SERIALCOMM/);

  const pnp = pnpDiagnostics().map((cmd) => cmd.command).join("\n");
  assert.match(pnp, /Get-PnpDevice/);
  assert.match(pnp, /devcon status/);
  assert.match(pnp, /Win32_PnPSignedDriver/);
});

test("driverTestMode exige autorização para testsigning", () => {
  const denied = driverTestMode({ authorized: false, enable: true });
  assert.equal(denied.stateChanging.length, 0);
  assert.ok(denied.readOnly.some((cmd) => cmd.command === "bcdedit /enum {current}"));
  assert.match(denied.note, /authorized=false/);
  assert.ok(denied.warnings.some((warning) => warning.includes("nointegritychecks")));

  const allowed = driverTestMode({ authorized: true, enable: true });
  assert.ok(allowed.stateChanging.some((cmd) => cmd.command === "bcdedit /set testsigning on"));
  assert.ok(allowed.stateChanging.some((cmd) => cmd.command.startsWith("shutdown /r")));

  const disable = driverTestMode({ authorized: true, enable: false });
  assert.ok(disable.stateChanging.some((cmd) => cmd.command === "bcdedit /set testsigning off"));
});

test("notas WinUSB e INF de exemplo mencionam winusb.inf e hardware ID", () => {
  assert.ok(winUsbNotes().some((note) => note.includes("WinUSB")));
  const inf = winUsbInfTemplate({
    manufacturer: "M5",
    deviceName: "M5 Device",
    vid: "0403",
    pid: "6001",
  });
  assert.match(inf, /Include=winusb\.inf/);
  assert.match(inf, /Needs=WINUSB\.NT/);
  assert.match(inf, /USB\\VID_0403&PID_6001/);
});
