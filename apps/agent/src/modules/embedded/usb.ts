/**
 * Banco de identificadores USB e decodificação de descritores.
 *
 * A tabela cobre fabricantes comuns em bancada de eletrônica, celulares e
 * consoles. VID/PID sozinho NÃO prova propriedade nem autoriza alteração:
 * serve para reconhecer o hardware e escolher o driver certo.
 *
 * Referências primárias: usb.ids (Linux USB ID Repository), documentação dos
 * fabricantes e descritores lidos com `lsusb -v` / `UsbView`.
 */

import type {
  UsbClassInfo,
  UsbConfigurationDescriptor,
  UsbDescriptor,
  UsbDevice,
  UsbEndpointDescriptor,
  UsbInterfaceDescriptor,
  VidPidEntry,
} from "./types";

/** Nomes de fabricantes por VID (inclui VIDs sem par PID na tabela). */
const VENDOR_NAMES: Readonly<Record<number, string>> = {
  0x18d1: "Google",
  0x04e8: "Samsung Electronics",
  0x05c6: "Qualcomm",
  0x0e8d: "MediaTek",
  0x05ac: "Apple",
  0x0403: "Future Technology Devices International (FTDI)",
  0x10c4: "Silicon Laboratories",
  0x2341: "Arduino",
  0x0483: "STMicroelectronics",
  0x2e8a: "Raspberry Pi",
  0x303a: "Espressif Systems",
  0x1915: "Nordic Semiconductor",
  0x0451: "Texas Instruments",
  0x04d8: "Microchip Technology",
  0x1fc9: "NXP Semiconductors",
  0x0a5c: "Broadcom",
  0x0bda: "Realtek Semiconductor",
  0x8087: "Intel",
  0x054c: "Sony Interactive Entertainment",
  0x057e: "Nintendo",
};

/**
 * Pares VID/PID reais e documentados (>= 40). Produtos mudam de PID entre
 * revisões; quando o PID exato não aparece, use `vendorName` + `lsusb`.
 */
export const USB_DEVICE_TABLE: readonly VidPidEntry[] = [
  // Google / Android (gadget e fastboot)
  { vid: 0x18d1, pid: 0x4ee7, vendor: "Google", product: "Pixel / Nexus (MTP + ADB)", family: "android" },
  { vid: 0x18d1, pid: 0x4ee2, vendor: "Google", product: "Pixel / Nexus (MTP)", family: "android" },
  { vid: 0x18d1, pid: 0x4ee1, vendor: "Google", product: "Pixel / Nexus (PTP)", family: "android" },
  { vid: 0x18d1, pid: 0x4ee0, vendor: "Google", product: "Pixel / Nexus (MTP legado)", family: "android" },
  { vid: 0x18d1, pid: 0xd00d, vendor: "Google", product: "Android Fastboot", family: "android", notes: "Bootloader; gravação exige autorização do proprietário." },

  // Samsung
  { vid: 0x04e8, pid: 0x6860, vendor: "Samsung", product: "Galaxy (MTP)", family: "android" },
  { vid: 0x04e8, pid: 0x6863, vendor: "Samsung", product: "Galaxy (MTP + ADB)", family: "android" },
  { vid: 0x04e8, pid: 0x6864, vendor: "Samsung", product: "Galaxy (PTP)", family: "android" },
  { vid: 0x04e8, pid: 0x685d, vendor: "Samsung", product: "Galaxy Download Mode (Odin)", family: "android", notes: "Modo de gravação; não contorna Knox Guard/FRP." },
  { vid: 0x04e8, pid: 0x6865, vendor: "Samsung", product: "Galaxy (MTP + ADB, modem)", family: "android" },
  { vid: 0x04e8, pid: 0x681c, vendor: "Samsung", product: "Galaxy (MTP, geração antiga)", family: "android" },
  { vid: 0x04e8, pid: 0x681d, vendor: "Samsung", product: "Galaxy (PTP, geração antiga)", family: "android" },

  // Qualcomm (EDL/diagnóstico)
  { vid: 0x05c6, pid: 0x9008, vendor: "Qualcomm", product: "HS-USB QDLoader 9008 (EDL)", family: "qualcomm", notes: "Emergency Download; gravação exige autorização e pacote oficial." },
  { vid: 0x05c6, pid: 0x900e, vendor: "Qualcomm", product: "HS-USB QDLoader 900e (EDL)", family: "qualcomm" },
  { vid: 0x05c6, pid: 0x9006, vendor: "Qualcomm", product: "HS-USB Diagnostics 9006", family: "qualcomm" },
  { vid: 0x05c6, pid: 0x9091, vendor: "Qualcomm", product: "HS-USB Diagnostics 9091", family: "qualcomm" },
  { vid: 0x05c6, pid: 0x9025, vendor: "Qualcomm", product: "HS-USB NMEA 9025 (GPS)", family: "qualcomm" },
  { vid: 0x05c6, pid: 0x901d, vendor: "Qualcomm", product: "HS-USB Diagnostics 901d", family: "qualcomm" },

  // MediaTek (preloader/MTP)
  { vid: 0x0e8d, pid: 0x0003, vendor: "MediaTek", product: "MTK Preloader / USB Port", family: "mediatek" },
  { vid: 0x0e8d, pid: 0x2000, vendor: "MediaTek", product: "MT65xx Android Phone", family: "android" },
  { vid: 0x0e8d, pid: 0x2001, vendor: "MediaTek", product: "MT65xx Android Phone (ADB)", family: "android" },
  { vid: 0x0e8d, pid: 0x2008, vendor: "MediaTek", product: "MTK MTP", family: "android" },
  { vid: 0x0e8d, pid: 0x201c, vendor: "MediaTek", product: "MTK MTP + ADB", family: "android" },
  { vid: 0x0e8d, pid: 0x201d, vendor: "MediaTek", product: "MTK PTP + ADB", family: "android" },

  // Apple
  { vid: 0x05ac, pid: 0x12a8, vendor: "Apple", product: "iPhone / iPad (modo normal)", family: "apple" },
  { vid: 0x05ac, pid: 0x1227, vendor: "Apple", product: "Apple Mobile Device (DFU)", family: "apple", notes: "DFU; restauração só com ferramenta oficial e autorização." },
  { vid: 0x05ac, pid: 0x1281, vendor: "Apple", product: "iPhone / iPad (Recovery Mode)", family: "apple" },
  { vid: 0x05ac, pid: 0x1297, vendor: "Apple", product: "iPod (modo normal)", family: "apple" },

  // FTDI (USB-serial)
  { vid: 0x0403, pid: 0x6001, vendor: "FTDI", product: "FT232R USB UART", family: "usb-serial", notes: "Driver ftdi_sio no Linux; VCP no Windows." },
  { vid: 0x0403, pid: 0x6010, vendor: "FTDI", product: "FT2232C/D Dual UART", family: "usb-serial" },
  { vid: 0x0403, pid: 0x6011, vendor: "FTDI", product: "FT4232H Quad UART", family: "usb-serial" },
  { vid: 0x0403, pid: 0x6014, vendor: "FTDI", product: "FT232H High-Speed", family: "usb-serial" },
  { vid: 0x0403, pid: 0x6015, vendor: "FTDI", product: "FT231X USB UART", family: "usb-serial" },

  // Silicon Labs
  { vid: 0x10c4, pid: 0xea60, vendor: "Silicon Labs", product: "CP2102 USB to UART Bridge", family: "usb-serial" },
  { vid: 0x10c4, pid: 0xea70, vendor: "Silicon Labs", product: "CP2105 Dual UART", family: "usb-serial" },
  { vid: 0x10c4, pid: 0xea71, vendor: "Silicon Labs", product: "CP2108 Quad UART", family: "usb-serial" },

  // Arduino
  { vid: 0x2341, pid: 0x0043, vendor: "Arduino", product: "Arduino Uno R3", family: "mcu" },
  { vid: 0x2341, pid: 0x0010, vendor: "Arduino", product: "Arduino Mega 2560", family: "mcu" },
  { vid: 0x2341, pid: 0x003d, vendor: "Arduino", product: "Arduino Due (programming port)", family: "mcu" },
  { vid: 0x2341, pid: 0x8036, vendor: "Arduino", product: "Arduino Leonardo", family: "mcu" },
  { vid: 0x2341, pid: 0x8037, vendor: "Arduino", product: "Arduino Micro", family: "mcu" },

  // STMicroelectronics
  { vid: 0x0483, pid: 0x3748, vendor: "STMicroelectronics", product: "ST-LINK/V2", family: "debug-probe" },
  { vid: 0x0483, pid: 0x374b, vendor: "STMicroelectronics", product: "ST-LINK/V2-1", family: "debug-probe" },
  { vid: 0x0483, pid: 0x374e, vendor: "STMicroelectronics", product: "ST-LINK/V3", family: "debug-probe" },
  { vid: 0x0483, pid: 0xdf11, vendor: "STMicroelectronics", product: "STM32 System Memory Bootloader (DFU)", family: "mcu", notes: "DFU; gravação altera firmware." },
  { vid: 0x0483, pid: 0x5740, vendor: "STMicroelectronics", product: "STM32 Virtual COM Port", family: "usb-serial" },

  // Raspberry Pi
  { vid: 0x2e8a, pid: 0x0003, vendor: "Raspberry Pi", product: "Raspberry Pi Pico (BOOTSEL)", family: "mcu" },
  { vid: 0x2e8a, pid: 0x0005, vendor: "Raspberry Pi", product: "Raspberry Pi Pico (CDC/MicroPython)", family: "mcu" },
  { vid: 0x2e8a, pid: 0x000c, vendor: "Raspberry Pi", product: "Raspberry Pi Debug Probe", family: "debug-probe" },

  // Espressif
  { vid: 0x303a, pid: 0x1001, vendor: "Espressif", product: "ESP32-S2/S3 USB JTAG/serial", family: "mcu" },
  { vid: 0x303a, pid: 0x0002, vendor: "Espressif", product: "ESP32-S2 USB OTG", family: "mcu" },
  { vid: 0x303a, pid: 0x4001, vendor: "Espressif", product: "ESP32-S3 USB Serial/JTAG", family: "mcu" },

  // Nordic Semiconductor
  { vid: 0x1915, pid: 0x521f, vendor: "Nordic Semiconductor", product: "nRF52840 Dongle (PCA10059)", family: "mcu" },
  { vid: 0x1915, pid: 0x522a, vendor: "Nordic Semiconductor", product: "nRF52840 DK (PCA10056)", family: "debug-probe" },

  // Texas Instruments
  { vid: 0x0451, pid: 0xbef3, vendor: "Texas Instruments", product: "XDS110 Debug Probe", family: "debug-probe" },
  { vid: 0x0451, pid: 0x16a8, vendor: "Texas Instruments", product: "CC2531 Zigbee USB Dongle", family: "mcu" },
  { vid: 0x0451, pid: 0xf432, vendor: "Texas Instruments", product: "MSP430 LaunchPad (USB FET)", family: "debug-probe" },

  // Microchip
  { vid: 0x04d8, pid: 0x0033, vendor: "Microchip", product: "PICkit 2", family: "debug-probe" },
  { vid: 0x04d8, pid: 0x900a, vendor: "Microchip", product: "PICkit 3", family: "debug-probe" },
  { vid: 0x04d8, pid: 0x9012, vendor: "Microchip", product: "PICkit 4", family: "debug-probe" },

  // NXP
  { vid: 0x1fc9, pid: 0x0094, vendor: "NXP", product: "LPC-Link2", family: "debug-probe" },
  { vid: 0x1fc9, pid: 0x0143, vendor: "NXP", product: "MCU-Link", family: "debug-probe" },
  { vid: 0x1fc9, pid: 0x0128, vendor: "NXP", product: "LPC1768 (mbed)", family: "mcu" },

  // Broadcom
  { vid: 0x0a5c, pid: 0x21e8, vendor: "Broadcom", product: "BCM20702A0 Bluetooth 4.0", family: "wireless" },
  { vid: 0x0a5c, pid: 0x21e6, vendor: "Broadcom", product: "BCM20702 Bluetooth", family: "wireless" },
  { vid: 0x0a5c, pid: 0x6412, vendor: "Broadcom", product: "BCM43142 Bluetooth/Wi-Fi", family: "wireless" },

  // Realtek
  { vid: 0x0bda, pid: 0x8153, vendor: "Realtek", product: "RTL8153 Gigabit Ethernet", family: "network" },
  { vid: 0x0bda, pid: 0x8152, vendor: "Realtek", product: "RTL8152 Fast Ethernet", family: "network" },
  { vid: 0x0bda, pid: 0x0129, vendor: "Realtek", product: "RTS5129 Card Reader", family: "storage" },
  { vid: 0x0bda, pid: 0x8723, vendor: "Realtek", product: "RTL8723 Bluetooth/Wi-Fi", family: "wireless" },

  // Intel
  { vid: 0x8087, pid: 0x0026, vendor: "Intel", product: "AX201 Bluetooth", family: "wireless" },
  { vid: 0x8087, pid: 0x0029, vendor: "Intel", product: "AX200 Bluetooth", family: "wireless" },
  { vid: 0x8087, pid: 0x0a2b, vendor: "Intel", product: "Intel Bluetooth", family: "wireless" },

  // Sony (controles)
  { vid: 0x054c, pid: 0x0ce6, vendor: "Sony", product: "DualSense Wireless Controller (PS5)", family: "hid" },
  { vid: 0x054c, pid: 0x09cc, vendor: "Sony", product: "DualShock 4 (CUH-ZCT2)", family: "hid" },
  { vid: 0x054c, pid: 0x05c4, vendor: "Sony", product: "DualShock 4 (CUH-ZCT1)", family: "hid" },

  // Nintendo (controles)
  { vid: 0x057e, pid: 0x2009, vendor: "Nintendo", product: "Switch Pro Controller", family: "hid" },
  { vid: 0x057e, pid: 0x2006, vendor: "Nintendo", product: "Joy-Con (L)", family: "hid" },
  { vid: 0x057e, pid: 0x2007, vendor: "Nintendo", product: "Joy-Con (R)", family: "hid" },
];

function parseId(value: string | number): number {
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
      throw new Error(`ID USB inválido: ${value}`);
    }
    return value;
  }
  const text = value.trim().replace(/^0x/i, "");
  if (!/^[0-9a-f]{1,4}$/i.test(text)) {
    throw new Error(`ID USB inválido: "${value}" (esperado hexadecimal de 1 a 4 dígitos)`);
  }
  return Number.parseInt(text, 16);
}

export function formatId(value: number): string {
  return value.toString(16).padStart(4, "0");
}

/** Procura um par VID/PID exato. Aceita número ou string hexadecimal. */
export function lookupVidPid(
  vid: string | number,
  pid: string | number,
): VidPidEntry | null {
  const v = parseId(vid);
  const p = parseId(pid);
  return USB_DEVICE_TABLE.find((entry) => entry.vid === v && entry.pid === p) ?? null;
}

/** Nome do fabricante pelo VID, com fallback explícito para desconhecidos. */
export function vendorName(vid: string | number): string {
  const v = parseId(vid);
  return VENDOR_NAMES[v] ?? `Desconhecido (VID 0x${formatId(v)})`;
}

const USB_CLASS_NAMES: Readonly<Record<number, string>> = {
  0x00: "Definida por interface",
  0x01: "Áudio",
  0x02: "Communications and CDC Control",
  0x03: "Human Interface Device (HID)",
  0x05: "Physical",
  0x06: "Image (PTP/MTP)",
  0x07: "Printer",
  0x08: "Mass Storage",
  0x09: "Hub",
  0x0a: "CDC Data",
  0x0b: "Smart Card",
  0x0d: "Content Security",
  0x0e: "Video",
  0x0f: "Healthcare",
  0x10: "Audio/Video",
  0x11: "Billboard",
  0x12: "USB Type-C Bridge",
  0xdc: "Diagnostic",
  0xe0: "Wireless Controller",
  0xef: "Miscellaneous",
  0xfe: "Application Specific",
  0xff: "Vendor Specific",
};

const USB_DESCRIPTOR_TYPES: Readonly<Record<number, string>> = {
  0x01: "DEVICE",
  0x02: "CONFIGURATION",
  0x03: "STRING",
  0x04: "INTERFACE",
  0x05: "ENDPOINT",
  0x06: "DEVICE_QUALIFIER",
  0x07: "OTHER_SPEED_CONFIGURATION",
  0x08: "INTERFACE_POWER",
  0x0b: "INTERFACE_ASSOCIATION",
  0x21: "HID",
  0x22: "HID_REPORT",
  0x23: "HID_PHYSICAL",
  0x24: "HUB",
  0x25: "ENDPOINT_COMPANION",
  0x30: "SUPERSPEED_ENDPOINT_COMPANION",
};

/**
 * Decodifica classe/subclasse/protocolo USB em texto útil.
 * Não substitui o descritor completo: alguns dispositivos usam classes
 * proprietárias (0xff) e precisam do driver do fabricante.
 */
export function decodeUsbClass(
  classCode: number,
  subclassCode = 0,
  protocolCode = 0,
): UsbClassInfo {
  const className = USB_CLASS_NAMES[classCode] ?? `Classe 0x${classCode.toString(16)}`;
  let detail = "Sem detalhe padronizado para esta combinação.";

  switch (classCode) {
    case 0x01:
      detail = subclassCode === 0x01 ? "Audio Control" : subclassCode === 0x02 ? "Audio Streaming" : "Áudio";
      break;
    case 0x02:
      if (subclassCode === 0x02) {
        detail = protocolCode === 0x01
          ? "CDC ACM (modem serial; AT commands)"
          : "CDC ACM (modem serial)";
      } else if (subclassCode === 0x06) {
        detail = "CDC ECM (Ethernet)";
      } else if (subclassCode === 0x0e) {
        detail = "CDC MBIM (banda larga móvel)";
      } else {
        detail = "CDC (comunicações)";
      }
      break;
    case 0x03:
      if (subclassCode === 0x01 && protocolCode === 0x01) detail = "HID Boot: teclado";
      else if (subclassCode === 0x01 && protocolCode === 0x02) detail = "HID Boot: mouse";
      else detail = "HID (teclado, mouse, gamepad ou relatório próprio)";
      break;
    case 0x06:
      detail = subclassCode === 0x01 && protocolCode === 0x01
        ? "PTP (Picture Transfer Protocol)"
        : "Image (MTP/PTP)";
      break;
    case 0x08:
      if (subclassCode === 0x06 && protocolCode === 0x50) detail = "SCSI transparente, Bulk-Only (pen drive/HD externo)";
      else if (subclassCode === 0x06) detail = "SCSI transparente";
      else if (subclassCode === 0x50) detail = "Bulk-Only Transport";
      else detail = "Mass Storage";
      break;
    case 0x09:
      detail = `Hub USB (protocolo ${protocolCode}; 0=FS, 1=HS, 2=SS, 3=SS+)`;
      break;
    case 0xdc:
      detail = subclassCode === 0x01 ? "Debug (USB Debug Class)" : "Diagnostic";
      break;
    case 0xe0:
      detail = subclassCode === 0x01 && protocolCode === 0x01
        ? "Bluetooth (HCI over USB)"
        : "Wireless Controller (RF)";
      break;
    case 0xef:
      detail = subclassCode === 0x02 && protocolCode === 0x01
        ? "Miscellaneous/Common, Interface Association Descriptor"
        : "Miscellaneous";
      break;
    case 0xfe:
      detail = subclassCode === 0x01
        ? (protocolCode === 0x02 ? "DFU (Device Firmware Upgrade) em modo DFU" : "DFU (Device Firmware Upgrade)")
        : "Application Specific";
      break;
    case 0xff:
      detail = subclassCode === 0x42 && protocolCode === 0x01
        ? "Android ADB (vendor-specific 0xff/0x42/0x01)"
        : "Vendor Specific (driver do fabricante)";
      break;
    default:
      break;
  }

  return {
    classCode,
    subclassCode,
    protocolCode,
    label: className,
    detail,
  };
}

/** Nome de um tipo de descritor (para logs e CLI). */
export function descriptorTypeName(type: number): string {
  return USB_DESCRIPTOR_TYPES[type] ?? `Tipo 0x${type.toString(16)}`;
}

function hexToBytes(hex: string): Uint8Array {
  const cleaned = hex.replace(/0x/gi, "").replace(/[^0-9a-f]/gi, "");
  if (cleaned.length === 0) throw new Error("Hex vazio: informe os bytes do descritor");
  if (cleaned.length % 2 !== 0) throw new Error("Hex com quantidade ímpar de dígitos");
  const bytes = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function le16(bytes: Uint8Array, offset: number): number {
  if (offset + 1 >= bytes.length) throw new Error(`Descritor truncado no offset ${offset}`);
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Interpreta um descritor de dispositivo USB (18 bytes) seguido, opcionalmente,
 * de configuration/interface/endpoint descriptors, como a saída de `lsusb -v`
 * em hexadecimal ou um dump de `UsbView`.
 *
 * Layout little-endian conforme USB 2.0, seção 9.6.
 */
export function parseUsbDescriptors(hex: string): UsbDescriptor {
  const bytes = hexToBytes(hex);
  if (bytes.length < 18) {
    throw new Error(`Descritor de dispositivo precisa de 18 bytes; recebidos ${bytes.length}`);
  }
  const bLength = bytes[0]!;
  if (bLength < 18) throw new Error(`bLength inválido para device descriptor: ${bLength}`);
  if (bytes[1] !== 0x01) {
    throw new Error(`bDescriptorType esperado 0x01 (DEVICE); recebido 0x${bytes[1]!.toString(16)}`);
  }

  const descriptor: UsbDescriptor = {
    bLength,
    bDescriptorType: bytes[1]!,
    bcdUSB: le16(bytes, 2),
    deviceClass: bytes[4]!,
    deviceSubclass: bytes[5]!,
    deviceProtocol: bytes[6]!,
    maxPacketSize0: bytes[7]!,
    idVendor: le16(bytes, 8),
    idProduct: le16(bytes, 10),
    bcdDevice: le16(bytes, 12),
    iManufacturer: bytes[14]!,
    iProduct: bytes[15]!,
    iSerialNumber: bytes[16]!,
    numConfigurations: bytes[17]!,
    raw: bytesToHex(bytes),
  };

  let config: UsbConfigurationDescriptor | undefined;
  let currentInterface: UsbInterfaceDescriptor | undefined;
  let offset = bLength;

  while (offset + 1 < bytes.length) {
    const length = bytes[offset]!;
    const type = bytes[offset + 1]!;
    if (length === 0) break; // evita loop infinito em dump inválido
    if (offset + length > bytes.length) {
      throw new Error(`Descritor tipo 0x${type.toString(16)} truncado no offset ${offset}`);
    }

    if (type === 0x02) {
      if (length < 9) throw new Error("Configuration descriptor com menos de 9 bytes");
      const attributes = bytes[offset + 7]!;
      config = {
        value: bytes[offset + 5]!,
        numInterfaces: bytes[offset + 4]!,
        stringIndex: bytes[offset + 6]!,
        attributes,
        selfPowered: (attributes & 0x40) !== 0,
        remoteWakeup: (attributes & 0x20) !== 0,
        maxPowermA: bytes[offset + 8]! * 2,
        interfaces: [],
      };
      // Mantém somente a primeira configuração; o uso comum tem uma.
      if (!descriptor.configuration) descriptor.configuration = config;
    } else if (type === 0x04) {
      if (length < 9) throw new Error("Interface descriptor com menos de 9 bytes");
      currentInterface = {
        interfaceNumber: bytes[offset + 2]!,
        alternateSetting: bytes[offset + 3]!,
        numEndpoints: bytes[offset + 4]!,
        classCode: bytes[offset + 5]!,
        subclassCode: bytes[offset + 6]!,
        protocolCode: bytes[offset + 7]!,
        stringIndex: bytes[offset + 8]!,
        endpoints: [],
      };
      if (config) config.interfaces.push(currentInterface);
    } else if (type === 0x05) {
      if (length < 7) throw new Error("Endpoint descriptor com menos de 7 bytes");
      const address = bytes[offset + 2]!;
      const attributes = bytes[offset + 3]!;
      const transferType = (["control", "isochronous", "bulk", "interrupt"] as const)[attributes & 0x03]!;
      const endpoint: UsbEndpointDescriptor = {
        address,
        number: address & 0x0f,
        direction: (address & 0x80) !== 0 ? "in" : "out",
        transferType,
        maxPacketSize: le16(bytes, offset + 4) & 0x07ff,
        interval: bytes[offset + 6]!,
      };
      if (currentInterface) currentInterface.endpoints.push(endpoint);
    }

    offset += length;
  }

  return descriptor;
}

/** Formata um BCD USB (ex.: 0x0200 => "2.00"). */
export function formatBcd(value: number): string {
  const major = value >> 8;
  const minor = value & 0xff;
  return `${major}.${minor.toString(16).padStart(2, "0")}`;
}

/** Resumo legível de um dispositivo ou descritor USB. */
export function describeDevice(input: UsbDevice | UsbDescriptor): string {
  const isDescriptor = "idVendor" in input;
  const vid = isDescriptor ? input.idVendor : input.vid;
  const pid = isDescriptor ? input.idProduct : input.pid;
  const entry = lookupVidPid(vid, pid);
  const vendor = isDescriptor ? vendorName(vid) : (input.vendor ?? vendorName(vid));
  const product = isDescriptor
    ? (entry?.product ?? "Produto não catalogado")
    : (input.product ?? entry?.product ?? "Produto não catalogado");
  const classCode = isDescriptor ? input.deviceClass : (input.classCode ?? 0);
  const subclassCode = isDescriptor ? input.deviceSubclass : (input.subclassCode ?? 0);
  const protocolCode = isDescriptor ? input.deviceProtocol : (input.protocolCode ?? 0);
  const cls = decodeUsbClass(classCode, subclassCode, protocolCode);

  const lines: string[] = [
    `${vendor} ${product}`,
    `VID:PID = ${formatId(vid)}:${formatId(pid)} (0x${formatId(vid)}:0x${formatId(pid)})`,
    `Classe = ${cls.label} | ${cls.detail}`,
  ];

  if (entry?.notes) lines.push(`Nota = ${entry.notes}`);
  if (entry) lines.push(`Família = ${entry.family}`);

  if (isDescriptor) {
    lines.push(
      `Versão USB = ${formatBcd(input.bcdUSB)} | bcdDevice = ${formatBcd(input.bcdDevice)}`,
      `Ep0 max packet = ${input.maxPacketSize0} bytes | configurações = ${input.numConfigurations}`,
      `Strings = manufacturer#${input.iManufacturer}, product#${input.iProduct}, serial#${input.iSerialNumber}`,
    );
    if (input.configuration) {
      const cfg = input.configuration;
      lines.push(
        `Configuração ${cfg.value}: ${cfg.numInterfaces} interface(s), ${cfg.maxPowermA} mA, self-powered=${cfg.selfPowered}, remote-wakeup=${cfg.remoteWakeup}`,
      );
      for (const iface of cfg.interfaces) {
        const decoded = decodeUsbClass(iface.classCode, iface.subclassCode, iface.protocolCode);
        lines.push(
          `  Interface ${iface.interfaceNumber}.${iface.alternateSetting}: ${decoded.label} / ${decoded.detail}`,
        );
        for (const ep of iface.endpoints) {
          lines.push(
            `    Endpoint 0x${ep.address.toString(16).padStart(2, "0")} ${ep.direction.toUpperCase()} ${ep.transferType}, maxPacket=${ep.maxPacketSize}, interval=${ep.interval}`,
          );
        }
      }
    }
  } else {
    const location = input.bus !== undefined && input.address !== undefined
      ? ` | barramento ${input.bus}, endereço ${input.address}`
      : "";
    if (input.serial) lines.push(`Serial = ${input.serial}${location}`);
    else if (location) lines.push(`Localização${location}`);
  }

  return lines.join("\n");
}
