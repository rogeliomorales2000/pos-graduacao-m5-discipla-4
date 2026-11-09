/**
 * Catálogo técnico de protocolos embarcados e matemática de temporização.
 *
 * Os números são valores típicos/documentados, não receitas universais:
 * sempre confirme no datasheet do componente e no padrão da camada física.
 */

import type { ProtocolSpec } from "./types";

/** Catálogo dos protocolos mais usados em bancada e campo. */
export const PROTOCOL_CATALOG: readonly ProtocolSpec[] = [
  {
    id: "uart",
    name: "UART (TTL/RS-232)",
    category: "serial",
    physical: "TX, RX e GND. TTL em 1,8/3,3/5 V; RS-232 usa ±3 a ±15 V e não é compatível direto com TTL.",
    topology: "Ponto a ponto, assíncrono, full-duplex quando TX e RX são independentes.",
    framing: "1 start bit + 5 a 9 data bits + paridade opcional + 1, 1,5 ou 2 stop bits. Baud define bits por segundo.",
    timing: {
      "baud típico": "9600, 19200, 57600, 115200, 921600",
      "erro de baud": "< 2% entre as duas pontas (ideal < 1%)",
      "nível lógico": "idle alto; start = transição para baixo",
      "flow control": "RTS/CTS opcional (hardware)",
    },
    notes: [
      "Não há clock compartilhado: as duas pontas precisam do mesmo baud e formato.",
      "Cabo longo em TTL sofre ruído; para distância use RS-485/RS-232 com transceiver.",
    ],
    references: ["EIA/TIA-232", "Datasheets de UART dos MCUs"],
  },
  {
    id: "i2c",
    name: "I2C / I²C",
    category: "bus",
    physical: "SDA e SCL em open-drain com pull-ups para 1,8/3,3/5 V, mais GND. Níveis dependem do barramento.",
    topology: "Multimaster, multi-drop; endereços de 7 ou 10 bits; clock stretching e arbitragem.",
    framing: "START, endereço + R/W, ACK/NACK, dados de 8 bits com ACK, STOP ou repeated START.",
    timing: {
      "standard mode": "100 kbit/s",
      "fast mode": "400 kbit/s",
      "fast mode plus": "1 Mbit/s",
      "high speed": "3,4 Mbit/s",
      "pull-up típico": "1,8 kΩ a 10 kΩ conforme capacitância do barramento",
      "endereços 7 bits": "0x08 a 0x77 utilizáveis; 0x00-0x07 e 0x78-0x7F reservados",
    },
    notes: [
      "Pull-ups calculadas por t_r = 0,8473 × R × C (limite do modo).",
      "Dispositivos lentos podem segurar SCL (clock stretching).",
      "Evite endereços duplicados no mesmo barramento.",
    ],
    references: ["NXP UM10204 — I2C-bus specification", "SMBus 3.x"],
  },
  {
    id: "spi",
    name: "SPI",
    category: "bus",
    physical: "SCLK, MOSI, MISO, CS (um por escravo) e GND; push-pull, normalmente 3,3 V.",
    topology: "Um mestre, vários escravos selecionados por CS; full-duplex.",
    framing: "Bits deslocados na borda definida por CPOL/CPHA (modos 0 a 3), MSB ou LSB first.",
    timing: {
      "clock típico": "1 a 50 MHz (alguns dispositivos chegam a 100 MHz)",
      "modos": "0: CPOL=0/CPHA=0; 1: 0/1; 2: 1/0; 3: 1/1",
      "CS": "ativo em nível baixo na maioria dos dispositivos",
    },
    notes: [
      "Sem ACK: o software precisa validar o dispositivo.",
      "Clock alto exige trilhas curtas e capacitância baixa.",
      "Confirme o modo SPI e a ordem dos bits no datasheet.",
    ],
    references: ["Motorola SPI Block Guide", "Datasheets dos periféricos"],
  },
  {
    id: "can",
    name: "CAN 2.0A/2.0B (e CAN FD)",
    category: "fieldbus",
    physical: "Par diferencial CAN_H/CAN_L, 120 Ω em cada extremidade; common-mode -2 a +7 V (drivers clássicos).",
    topology: "Multimaster com arbitragem por prioridade (CSMA/CR); 11 bits (2.0A) ou 29 bits (2.0B).",
    framing: "SOF, arbitragem, control, data (0-8 bytes clássico; até 64 em FD), CRC, ACK, EOF; bit stuffing.",
    timing: {
      "bitrate clássico": "10 kbit/s a 1 Mbit/s",
      "CAN FD data": "2 a 8 Mbit/s (trecho de dados)",
      "comprimento x bitrate": "40 m @ 1 Mbit/s; 100 m @ 500 kbit/s; 500 m @ 125 kbit/s",
      "terminação": "120 Ω em cada ponta (equivalente 60 Ω entre CAN_H e CAN_L)",
      "sample point": "75% a 87,5% (CiA recomendado)",
    },
    notes: [
      "Todos os nós precisam do mesmo bitrate e da mesma configuração de sample point.",
      "Sem terminação correta há reflexões e erros de CRC/ACK.",
      "CAN FD não é compatível com controladores clássicos no trecho de dados.",
    ],
    references: ["ISO 11898-1", "CiA 301", "Bosch CAN 2.0 specification"],
  },
  {
    id: "modbus-rtu",
    name: "Modbus RTU",
    category: "fieldbus",
    physical: "RS-485 diferencial (A/B) ou RS-232; 2 ou 4 fios, com GND de referência quando possível.",
    topology: "Mestre/escravo, até 247 endereços escravos; half-duplex em RS-485 de 2 fios.",
    framing: "Endereço (1 byte), função (1), dados, CRC-16 (2 bytes, low byte primeiro). Silêncio de 3,5 caracteres separa quadros.",
    timing: {
      "baud comum": "9600, 19200, 38400, 57600, 115200",
      "formato comum": "8E1 (8 dados, paridade par, 1 stop)",
      "silêncio entre quadros": "3,5 tempos de caractere (mínimo 1,75 ms acima de 19200)",
      "CRC": "CRC-16/Modbus: polinômio 0xA001 refletido, init 0xFFFF",
      "timeout": "300 ms a 1 s típico para resposta",
    },
    notes: [
      "O CRC vai no final, low byte primeiro; confira com vetor conhecido.",
      "Não misture 8N1 e 8E1 no mesmo barramento.",
      "RS-485 exige terminação e bias em barramentos longos.",
    ],
    references: ["Modbus Application Protocol V1.1b3", "Modbus over Serial Line V1.02"],
  },
  {
    id: "mqtt",
    name: "MQTT 3.1.1 / 5.0",
    category: "network",
    physical: "TCP/IP; 1883 sem TLS e 8883 com TLS. Em IoT pode rodar sobre TLS mútuo.",
    topology: "Pub/sub via broker; tópicos hierárquicos com curingas + e #.",
    framing: "Fixed header (tipo + flags + remaining length varint), variable header e payload.",
    timing: {
      "keepalive": "60 s típico; PINGREQ/PINGRESP",
      "QoS": "0 no máximo uma vez; 1 pelo menos uma vez; 2 exatamente uma vez",
      "remaining length": "varint de 1 a 4 bytes; máximo 268.435.455",
      "portas": "1883 (texto), 8883 (TLS)",
    },
    notes: [
      "O varint usa 7 bits por byte com bit de continuação 0x80.",
      "QoS 2 tem custo maior; muitos sensores usam QoS 0/1.",
      "Use TLS e credenciais por dispositivo em produção.",
    ],
    references: ["OASIS MQTT 3.1.1", "OASIS MQTT 5.0"],
  },
  {
    id: "ble-gatt",
    name: "BLE GATT",
    category: "wireless",
    physical: "Rádio 2,4 GHz, 40 canais de 2 MHz (3 de advertising); modulação GFSK.",
    topology: "Central/periférico; serviços e características organizam os atributos GATT.",
    framing: "Advertising/scanning, conexão, ATT (MTU padrão 23 bytes; negociável), notificações/indicações.",
    timing: {
      "connection interval": "7,5 ms a 4 s, passo de 1,25 ms",
      "slave latency": "0 a 499 eventos",
      "supervision timeout": "100 ms a 32 s, passo de 10 ms",
      "MTU": "23 bytes padrão; 247+ comum com DLE",
      "throughput": "depende de intervalo, MTU, PHY e latência",
    },
    notes: [
      "Supervision timeout deve ser maior que (1 + latency) × interval máximo × 2.",
      "Intervalos curtos aumentam consumo de energia.",
      "Notificações não têm confirmação; indicações têm ACK.",
    ],
    references: ["Bluetooth Core Specification 5.x", "GATT Specification Supplement"],
  },
  {
    id: "usb-cdc",
    name: "USB CDC (ACM)",
    category: "serial",
    physical: "USB 2.0/3.x: VBUS 5 V, D+/D- (ou pares SS), GND; 500 mA no USB 2.0 padrão.",
    topology: "Host/device; CDC ACM expõe uma porta serial virtual.",
    framing: "Descritores USB, interface de controle (classe 0x02, subclasse 0x02, protocolo 0x01) e interface de dados com endpoints bulk.",
    timing: {
      "USB 2.0 low/full/high": "1,5 / 12 / 480 Mbit/s",
      "max packet bulk": "64 bytes full-speed; 512 bytes high-speed",
      "VBUS": "5 V ±5%; 500 mA (USB 2.0) ou conforme negociação USB-C/PD",
      "driver Linux": "cdc_acm; Windows usa usbser.sys ou driver do fabricante",
    },
    notes: [
      "CDC ACM não é RS-232: os níveis elétricos são USB.",
      "O VID/PID identifica o dispositivo; a interface 0x02/0x02/0x01 indica ACM.",
      "Em Windows, drivers INF assinados são obrigatórios em produção.",
    ],
    references: ["USB CDC 1.2", "USB 2.0 specification"],
  },
  {
    id: "jtag-swd",
    name: "JTAG / SWD",
    category: "debug",
    physical: "JTAG: TCK, TMS, TDI, TDO, TRST opcional, GND e VREF. SWD: SWCLK, SWDIO, GND e VREF.",
    topology: "Ponto a ponto entre probe e alvo; SWD é o modo de 2 fios comum em Cortex-M.",
    framing: "Máquina de estados TAP (JTAG) ou pacotes SWD; acesso a registradores e memória via debug port.",
    timing: {
      "clock típico": "100 kHz a 50 MHz (SWD costuma operar até 10-50 MHz)",
      "VREF": "1,2 a 3,3 V conforme o alvo; nunca energize o alvo pelo probe",
      "hot-plug": "não recomendado; conecte GND antes dos sinais",
    },
    notes: [
      "Leitura/gravação de memória altera o dispositivo e exige autorização.",
      "Proteções de leitura (RDP) podem bloquear o acesso; não são contornadas aqui.",
      "Confirme a pinagem do conector no schematic; SWD não é universal.",
    ],
    references: ["ARM CoreSight", "IEEE 1149.1 (JTAG)"],
  },
  {
    id: "rs-485",
    name: "RS-485",
    category: "fieldbus",
    physical: "Par diferencial A/B, common-mode -7 a +12 V; 120 Ω nas extremidades; bias de falha.",
    topology: "Multiponto, half-duplex em 2 fios; até 32 unit loads clássicos (mais com transceivers modernos).",
    framing: "Camada física somente: o protocolo de aplicação define o quadro (ex.: Modbus RTU).",
    timing: {
      "distância x baud": "até 1200 m em baixa velocidade; 100 m a 1 Mbit/s (ordem de grandeza)",
      "terminação": "120 Ω em cada ponta",
      "bias": "pull-up em A e pull-down em B para estado idle definido",
      "isolamento": "recomendado em ambiente industrial",
    },
    notes: [
      "É half-duplex: um driver por vez; controle DE/RE com cuidado.",
      "GND de referência e proteção contra surtos são importantes em campo.",
      "RS-485 define elétrica, não o protocolo de dados.",
    ],
    references: ["TIA/EIA-485-A", "AN-1057 (Texas Instruments)"],
  },
];

export function getProtocol(id: string): ProtocolSpec | null {
  const key = id.trim().toLowerCase();
  return PROTOCOL_CATALOG.find((p) => p.id === key) ?? null;
}

export type UartParity = "none" | "even" | "odd" | "mark" | "space";

export interface UartFrameInput {
  data: string | Uint8Array | readonly number[];
  baud: number;
  /** Bits de dados por quadro (5 a 9). */
  bits?: number;
  parity?: UartParity;
  /** 1, 1,5 ou 2 (0,5 só é válido com 5 data bits em alguns UARTs). */
  stop?: number;
}

export interface UartFrameResult {
  bytes: number;
  dataBits: number;
  frameBits: number;
  totalBits: number;
  timeMs: number;
  timePerByteMs: number;
  overheadBits: number;
  overheadPercent: number;
  effectiveDataBps: number;
  settings: string;
}

function dataByteLength(data: string | Uint8Array | readonly number[]): number {
  if (typeof data === "string") return new TextEncoder().encode(data).length;
  return data.length;
}

const PARITY_BITS: Readonly<Record<UartParity, number>> = {
  none: 0,
  even: 1,
  odd: 1,
  mark: 1,
  space: 1,
};

const PARITY_LETTER: Readonly<Record<UartParity, string>> = {
  none: "N",
  even: "E",
  odd: "O",
  mark: "M",
  space: "S",
};

/** Calcula bits por quadro, tempo de transmissão e overhead de uma UART. */
export function uartFrame(input: UartFrameInput): UartFrameResult {
  const bits = input.bits ?? 8;
  const parity = input.parity ?? "none";
  const stop = input.stop ?? 1;
  if (!Number.isFinite(input.baud) || input.baud <= 0) {
    throw new Error(`baud inválido: ${input.baud}`);
  }
  if (!Number.isInteger(bits) || bits < 5 || bits > 9) {
    throw new Error(`bits de dados inválidos: ${bits} (use 5 a 9)`);
  }
  if (!(parity in PARITY_BITS)) throw new Error(`paridade inválida: ${parity}`);
  if (![0.5, 1, 1.5, 2].includes(stop)) {
    throw new Error(`stop bits inválido: ${stop} (use 0,5, 1, 1,5 ou 2)`);
  }
  if (stop === 0.5 && bits !== 5) {
    throw new Error("stop=0,5 só é válido com 5 data bits na maioria dos UARTs");
  }

  const bytes = dataByteLength(input.data);
  const frameBits = 1 + bits + PARITY_BITS[parity] + stop;
  const totalBits = frameBits * bytes;
  const timePerByteMs = (frameBits / input.baud) * 1000;
  const overheadBits = frameBits - bits;

  return {
    bytes,
    dataBits: bits,
    frameBits,
    totalBits,
    timeMs: (totalBits / input.baud) * 1000,
    timePerByteMs,
    overheadBits,
    overheadPercent: (overheadBits / bits) * 100,
    effectiveDataBps: (bits / frameBits) * input.baud,
    settings: `${input.baud} ${bits}${PARITY_LETTER[parity]}${stop}`,
  };
}

export interface I2cAddressResult {
  address7: number;
  write: number;
  read: number;
  hexWrite: string;
  hexRead: string;
  usable: boolean;
  warning?: string;
}

/** Converte endereço I2C de 7 bits para os bytes de escrita/leitura (8 bits). */
export function i2cAddress7to8(address: number): I2cAddressResult {
  if (!Number.isInteger(address) || address < 0x00 || address > 0x7f) {
    throw new Error(`endereço I2C de 7 bits inválido: ${address} (0x00 a 0x7F)`);
  }
  const write = (address << 1) & 0xfe;
  const read = write | 0x01;
  const usable = address >= 0x08 && address <= 0x77;
  return {
    address7: address,
    write,
    read,
    hexWrite: `0x${write.toString(16).padStart(2, "0")}`,
    hexRead: `0x${read.toString(16).padStart(2, "0")}`,
    usable,
    warning: usable
      ? undefined
      : "Faixa reservada pelo padrão I2C (0x00-0x07 ou 0x78-0x7F); confirme se o dispositivo realmente usa esse endereço.",
  };
}

export interface SpiClockInput {
  /** Clock de entrada do periférico em Hz. */
  freq: number;
  /** Divisor inteiro (2, 4, 8... na maioria dos MCUs). */
  prescaler: number;
}

export interface SpiClockResult {
  inputHz: number;
  prescaler: number;
  outputHz: number;
  outputMHz: number;
  periodNs: number;
}

/** Calcula o clock SPI de saída a partir do clock do periférico e do divisor. */
export function spiClock(input: SpiClockInput): SpiClockResult {
  if (!Number.isFinite(input.freq) || input.freq <= 0) {
    throw new Error(`frequência SPI inválida: ${input.freq}`);
  }
  if (!Number.isInteger(input.prescaler) || input.prescaler < 1) {
    throw new Error(`prescaler SPI inválido: ${input.prescaler}`);
  }
  const outputHz = input.freq / input.prescaler;
  return {
    inputHz: input.freq,
    prescaler: input.prescaler,
    outputHz,
    outputMHz: outputHz / 1e6,
    periodNs: (1 / outputHz) * 1e9,
  };
}

export interface CanBitTimingInput {
  clockHz: number;
  bitrate: number;
  /** Ponto de amostragem desejado (0,5 a 0,95); padrão 0,875. */
  samplePoint?: number;
}

export interface CanBitTimingResult {
  clockHz: number;
  bitrate: number;
  samplePointRequested: number;
  prescaler: number;
  /** Quantums de tempo por bit (sync + seg1 + seg2). */
  tq: number;
  syncSeg: number;
  seg1: number;
  seg2: number;
  samplePoint: number;
  bitrateActual: number;
  errorPct: number;
  warning?: string;
}

/**
 * Calcula prescaler e segmentos (sync/seg1/seg2) para um controlador CAN.
 *
 * Varre prescalers de 1 a 1024, exige 8 <= tq <= 25 (faixa recomendada) e
 * escolhe a menor combinação de erro de bitrate + desvio do sample point.
 */
export function canBitTiming(input: CanBitTimingInput): CanBitTimingResult {
  const samplePoint = input.samplePoint ?? 0.875;
  if (!Number.isFinite(input.clockHz) || input.clockHz <= 0) {
    throw new Error(`clock CAN inválido: ${input.clockHz}`);
  }
  if (!Number.isFinite(input.bitrate) || input.bitrate <= 0) {
    throw new Error(`bitrate CAN inválido: ${input.bitrate}`);
  }
  if (samplePoint < 0.5 || samplePoint > 0.95) {
    throw new Error(`sample point inválido: ${samplePoint} (use 0,5 a 0,95)`);
  }

  interface Candidate {
    prescaler: number;
    tq: number;
    seg1: number;
    seg2: number;
    sampleActual: number;
    bitrateActual: number;
    errorPct: number;
    score: number;
  }

  function search(minTq: number, maxTq: number): Candidate | null {
    let best: Candidate | null = null;
    for (let prescaler = 1; prescaler <= 1024; prescaler++) {
      const tq = Math.round(input.clockHz / (input.bitrate * prescaler));
      if (tq < minTq || tq > maxTq) continue;
      const seg2 = Math.min(tq - 2, Math.max(1, Math.round(tq * (1 - samplePoint))));
      const seg1 = tq - 1 - seg2;
      if (seg1 < 1 || seg2 < 1) continue;

      const bitrateActual = input.clockHz / (prescaler * tq);
      const errorPct = Math.abs(bitrateActual - input.bitrate) / input.bitrate * 100;
      const sampleActual = (1 + seg1) / tq;
      // Prefere 16 TQ (janela clássica e mais comum em 8..25), depois erro,
      // sample point e, por fim, o menor prescaler.
      const score =
        errorPct * 1000
        + Math.abs(sampleActual - samplePoint) * 100
        + Math.abs(tq - 16) * 0.01
        + prescaler * 0.001;
      if (!best || score < best.score) {
        best = {
          prescaler,
          tq,
          seg1,
          seg2,
          sampleActual,
          bitrateActual,
          errorPct,
          score,
        };
      }
    }
    return best;
  }

  const candidate = search(8, 25) ?? search(4, 385);
  if (!candidate) {
    throw new Error(
      `não foi possível achar temporização CAN para clock=${input.clockHz} bitrate=${input.bitrate}`,
    );
  }

  const warning = candidate.errorPct > 1
    ? `erro de bitrate ${candidate.errorPct.toFixed(3)}% acima de 1%; verifique o clock do controlador.`
    : undefined;

  return {
    clockHz: input.clockHz,
    bitrate: input.bitrate,
    samplePointRequested: samplePoint,
    prescaler: candidate.prescaler,
    tq: candidate.tq,
    syncSeg: 1,
    seg1: candidate.seg1,
    seg2: candidate.seg2,
    samplePoint: candidate.sampleActual,
    bitrateActual: candidate.bitrateActual,
    errorPct: candidate.errorPct,
    warning,
  };
}

export type ByteBuffer = Uint8Array | readonly number[];

function toBytes(buffer: ByteBuffer | string): Uint8Array {
  if (typeof buffer === "string") {
    const cleaned = buffer.replace(/0x/gi, "").replace(/[^0-9a-f]/gi, "");
    if (cleaned.length === 0 || cleaned.length % 2 !== 0) {
      throw new Error("buffer hexadecimal inválido");
    }
    const out = new Uint8Array(cleaned.length / 2);
    for (let i = 0; i < out.length; i++) {
      out[i] = Number.parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
  }
  const out = new Uint8Array(buffer.length);
  for (let i = 0; i < buffer.length; i++) {
    const value = buffer[i]!;
    if (!Number.isInteger(value) || value < 0 || value > 0xff) {
      throw new Error(`byte inválido no índice ${i}: ${value}`);
    }
    out[i] = value;
  }
  return out;
}

/**
 * CRC-16/Modbus (polinômio refletido 0xA001, init 0xFFFF).
 *
 * O valor interno retornado é 0xCDC5 para `01 03 00 00 00 0A`. No fio os
 * bytes vão low-byte primeiro: C5 CD. Use `modbusCrcHex` para exibição.
 */
export function modbusCrc16(buffer: ByteBuffer | string): number {
  const bytes = toBytes(buffer);
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 0x01) !== 0 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
    }
  }
  return crc & 0xffff;
}

/** Bytes do CRC na ordem de transmissão do Modbus RTU (low byte primeiro). */
export function modbusCrcBytes(buffer: ByteBuffer | string): [number, number] {
  const crc = modbusCrc16(buffer);
  return [crc & 0xff, (crc >> 8) & 0xff];
}

/** CRC Modbus em hexadecimal na ordem de transmissão (ex.: "C5 CD"). */
export function modbusCrcHex(buffer: ByteBuffer | string): string {
  return modbusCrcBytes(buffer)
    .map((b) => b.toString(16).padStart(2, "0").toUpperCase())
    .join(" ");
}

/** Monta um quadro Modbus RTU com o CRC anexado. */
export function modbusFrame(buffer: ByteBuffer | string): {
  payload: number[];
  crc: number;
  bytes: number[];
  hex: string;
} {
  const payload = Array.from(toBytes(buffer));
  const crcBytes = modbusCrcBytes(payload);
  const bytes = [...payload, ...crcBytes];
  return {
    payload,
    crc: modbusCrc16(payload),
    bytes,
    hex: bytes.map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" "),
  };
}

export interface MqttRemainingLengthResult {
  value: number;
  bytes: number[];
  hex: string;
  length: number;
}

/** Codifica o "remaining length" do MQTT como varint de 1 a 4 bytes. */
export function mqttRemainingLength(value: number): MqttRemainingLengthResult {
  if (!Number.isInteger(value) || value < 0 || value > 268_435_455) {
    throw new Error(`remaining length MQTT inválido: ${value} (0 a 268435455)`);
  }
  const bytes: number[] = [];
  let remaining = value;
  do {
    let byte = remaining % 128;
    remaining = Math.floor(remaining / 128);
    if (remaining > 0) byte |= 0x80;
    bytes.push(byte);
  } while (remaining > 0);

  return {
    value,
    bytes,
    hex: bytes.map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" "),
    length: bytes.length,
  };
}

export interface BleConnectionIntervalInput {
  /** Intervalo único em ms (atalho); se informado, define min e max. */
  intervalMs?: number;
  minMs?: number;
  maxMs?: number;
  /** Slave latency em eventos (0 a 499). */
  latency?: number;
  /** Supervision timeout em ms; se omitido, é calculado com margem. */
  supervisionTimeoutMs?: number;
}

export interface BleConnectionIntervalResult {
  minUnits: number;
  maxUnits: number;
  minMs: number;
  maxMs: number;
  latency: number;
  supervisionTimeoutUnits: number;
  supervisionTimeoutMs: number;
  effectiveConnectionIntervalMs: number;
  note: string;
}

/** Converte e valida intervalos de conexão BLE nas unidades de 1,25 ms. */
export function bleConnectionInterval(
  input: BleConnectionIntervalInput,
): BleConnectionIntervalResult {
  const minMs = input.intervalMs ?? input.minMs;
  const maxMs = input.intervalMs ?? input.maxMs ?? minMs;
  if (minMs === undefined || maxMs === undefined) {
    throw new Error("informe intervalMs ou minMs/maxMs");
  }
  if (minMs > maxMs) throw new Error(`minMs (${minMs}) maior que maxMs (${maxMs})`);

  const minUnits = Math.round(minMs / 1.25);
  const maxUnits = Math.round(maxMs / 1.25);
  if (minUnits < 6 || maxUnits > 3200) {
    throw new Error(
      `intervalo BLE fora da faixa 7,5 ms a 4 s (unidades 6 a 3200): ${minUnits}..${maxUnits}`,
    );
  }

  const latency = input.latency ?? 0;
  if (!Number.isInteger(latency) || latency < 0 || latency > 499) {
    throw new Error(`latency BLE inválida: ${latency} (0 a 499)`);
  }

  // Regra do Core: supervision timeout > (1 + latency) * maxInterval * 2.
  const minimumTimeoutMs = (1 + latency) * maxUnits * 1.25 * 2;
  const requested = input.supervisionTimeoutMs
    ?? Math.max(100, Math.ceil((minimumTimeoutMs + 10) / 10) * 10);
  const timeoutUnits = Math.round(requested / 10);
  if (timeoutUnits < 10 || timeoutUnits > 3200) {
    throw new Error(
      `supervision timeout BLE fora da faixa 100 ms a 32 s: ${requested} ms`,
    );
  }
  const timeoutMs = timeoutUnits * 10;
  if (timeoutMs <= minimumTimeoutMs) {
    throw new Error(
      `supervision timeout ${timeoutMs} ms deve ser maior que (1 + latency) × maxInterval × 2 = ${minimumTimeoutMs.toFixed(2)} ms`,
    );
  }

  return {
    minUnits,
    maxUnits,
    minMs: minUnits * 1.25,
    maxMs: maxUnits * 1.25,
    latency,
    supervisionTimeoutUnits: timeoutUnits,
    supervisionTimeoutMs: timeoutMs,
    effectiveConnectionIntervalMs: maxUnits * 1.25,
    note:
      "Intervalos curtos reduzem latência e aumentam consumo. O periférico pode contrapropor; sempre negocie os parâmetros na conexão.",
  };
}

/** Texto formatado de uma especificação de protocolo. */
export function describeProtocol(spec: ProtocolSpec): string {
  const timing = Object.entries(spec.timing)
    .map(([key, value]) => `  ${key}: ${value}`)
    .join("\n");
  return [
    `${spec.name} [${spec.id}] — ${spec.category}`,
    `Física: ${spec.physical}`,
    `Topologia: ${spec.topology}`,
    `Quadro: ${spec.framing}`,
    "Temporização/elétrica:",
    timing,
    ...spec.notes.map((note) => `Nota: ${note}`),
    `Refs: ${spec.references.join("; ")}`,
  ].join("\n");
}
