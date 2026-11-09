/**
 * Tipos compartilhados do módulo de sistemas embarcados.
 *
 * A ideia é descrever hardware e protocolos com dados verificáveis, sem
 * esconder o que cada operação faz. Qualquer ação que altere estado precisa
 * de autorização explícita; o módulo nunca assume consentimento.
 */

/** Dispositivo USB identificado por VID/PID (16 bits cada). */
export interface UsbDevice {
  vid: number;
  pid: number;
  vendor?: string;
  product?: string;
  serial?: string;
  bus?: number;
  address?: number;
  /** bDeviceClass do descritor, quando disponível. */
  classCode?: number;
  /** bDeviceSubClass do descritor, quando disponível. */
  subclassCode?: number;
  /** bDeviceProtocol do descritor, quando disponível. */
  protocolCode?: number;
}

/** Endpoint USB decodificado (descritor 0x05). */
export interface UsbEndpointDescriptor {
  address: number;
  number: number;
  direction: "in" | "out";
  transferType: "control" | "isochronous" | "bulk" | "interrupt";
  maxPacketSize: number;
  interval: number;
}

/** Interface USB decodificada (descritor 0x04). */
export interface UsbInterfaceDescriptor {
  interfaceNumber: number;
  alternateSetting: number;
  numEndpoints: number;
  classCode: number;
  subclassCode: number;
  protocolCode: number;
  stringIndex: number;
  endpoints: UsbEndpointDescriptor[];
}

/** Configuração USB decodificada (descritor 0x02). */
export interface UsbConfigurationDescriptor {
  value: number;
  numInterfaces: number;
  stringIndex: number;
  attributes: number;
  selfPowered: boolean;
  remoteWakeup: boolean;
  maxPowermA: number;
  interfaces: UsbInterfaceDescriptor[];
}

/** Descritor de dispositivo USB (18 bytes) + configuração opcional. */
export interface UsbDescriptor {
  bLength: number;
  bDescriptorType: number;
  bcdUSB: number;
  deviceClass: number;
  deviceSubclass: number;
  deviceProtocol: number;
  maxPacketSize0: number;
  idVendor: number;
  idProduct: number;
  bcdDevice: number;
  iManufacturer: number;
  iProduct: number;
  iSerialNumber: number;
  numConfigurations: number;
  configuration?: UsbConfigurationDescriptor;
  /** Bytes originais em hexadecimal, sem separadores. */
  raw: string;
}

/** Entrada da tabela VID/PID com nome de produto documentado. */
export interface VidPidEntry {
  vid: number;
  pid: number;
  vendor: string;
  product: string;
  /** Família útil para diagnóstico (ex.: "android", "usb-serial"). */
  family: string;
  notes?: string;
}

/** Decodificação legível de classe/subclasse/protocolo USB. */
export interface UsbClassInfo {
  classCode: number;
  subclassCode: number;
  protocolCode: number;
  label: string;
  detail: string;
}

/** Especificação resumida de um protocolo de campo/serial. */
export interface ProtocolSpec {
  id: string;
  name: string;
  category: "serial" | "fieldbus" | "bus" | "wireless" | "network" | "debug";
  /** Fiação e níveis elétricos. */
  physical: string;
  /** Topologia e número de participantes. */
  topology: string;
  /** Formato de quadro e regras de temporização. */
  framing: string;
  /** Parâmetros elétricos/temporais típicos. */
  timing: Record<string, string>;
  notes: string[];
  references: string[];
}

/**
 * Resultado de uma checagem de acesso a um dispositivo.
 *
 * `readOnly` indica se a operação devolvida apenas lê dados. Operações que
 * mudam estado ficam em `blocked` quando não há autorização.
 */
export interface DeviceAccess {
  readOnly: boolean;
  operations: string[];
  blocked: string[];
  notes: string[];
  requiresConsent: boolean;
}

/**
 * Evidência mínima de autorização para operar em um dispositivo.
 *
 * Não é um token criptográfico: é um registro auditável de quem autorizou,
 * qual dispositivo e até quando. O chamador continua responsável por validar
 * a documentação real (propriedade, contrato, ordem de serviço etc.).
 */
export interface Authorization {
  authorized: boolean;
  authorizedBy?: string;
  /** Referência externa: ticket, contrato, OS, e-mail, etc. */
  reference?: string;
  /** Identificador do dispositivo autorizado (serial, IMEI, VID:PID...). */
  scope?: string;
  /** ISO-8601; depois disso a autorização deve ser renovada. */
  expiresAt?: string;
  evidence?: string[];
  notes?: string;
}
