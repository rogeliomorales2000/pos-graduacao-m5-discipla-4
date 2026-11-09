/**
 * Linux embarcado: device tree, nós /dev, regras udev, units systemd e
 * ferramentas de diagnóstico (libgpiod, dmesg, lsusb, lsblk).
 *
 * Regra de ouro: gerar texto é inofensivo; instalar regra udev, habilitar
 * serviço ou acionar GPIO exige sudo e consentimento do administrador do
 * sistema. Funções privilegiadas recebem `authorized` e, quando falso,
 * devolvem apenas leitura + explicação.
 */

export interface DeviceTreeNode {
  name: string;
  label?: string;
  unitAddress?: string;
  properties: Record<string, string | true>;
  compatible: string[];
  children: DeviceTreeNode[];
}

export interface DevNodeInfo {
  path: string;
  subsystem: string;
  description: string;
  permissions: string;
  notes?: string;
}

export interface UdevRuleInput {
  authorized: boolean;
  vendorId: string | number;
  productId: string | number;
  /** Usa SUBSYSTEM=="usb" em vez de "tty". */
  subsystem?: "tty" | "usb" | "input" | "block";
  mode?: string;
  group?: string;
  symlink?: string;
  serial?: string;
}

export interface UdevRuleResult {
  authorized: boolean;
  content: string;
  installCommand: string;
  verifyCommand: string;
  requiresSudo: true;
  note: string;
}

export interface SystemdUnitInput {
  name: string;
  description: string;
  execStart: string;
  workdir?: string;
  user?: string;
  group?: string;
  restart?: "no" | "on-failure" | "always";
  after?: string[];
  wants?: string[];
  /** Necessário para devolver os comandos de instalação/habilitação. */
  authorized?: boolean;
  /** Diretórios que o serviço pode escrever (ProtectSystem=strict). */
  readWritePaths?: string[];
}

export interface SystemdUnitResult {
  name: string;
  content: string;
  installCommands: string[];
  requiresSudo: true;
  note: string;
}

export interface GpiodInput {
  chip: string;
  line: number | string;
  value?: 0 | 1;
  authorized?: boolean;
}

export interface GpiodResult {
  readOnly: string[];
  stateChanging: string[];
  notes: string[];
}

export interface LinuxCommand {
  command: string;
  description: string;
  readOnly: boolean;
  needsRoot?: boolean;
}

const DEVICE_TREE_EXAMPLE = `/dts-v1/;

/ {
    model = "M5 Dev Board";
    compatible = "m5,dev-board", "simple-bus";
    #address-cells = <1>;
    #size-cells = <1>;

    chosen {
        stdout-path = &uart0;
    };

    soc {
        compatible = "simple-bus";
        ranges;

        uart0: serial@10000000 {
            compatible = "snps,dw-apb-uart";
            reg = <0x10000000 0x1000>;
            interrupts = <10>;
            clock-frequency = <48000000>;
            status = "okay";
        };

        i2c1: i2c@10001000 {
            compatible = "snps,designware-i2c";
            reg = <0x10001000 0x1000>;
            #address-cells = <1>;
            #size-cells = <0>;
            clock-frequency = <400000>;

            sensor@48 {
                compatible = "ti,tmp102";
                reg = <0x48>;
            };
        };
    };
};
`;

export function deviceTreeExample(): string {
  return DEVICE_TREE_EXAMPLE;
}

function stripDtsComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/^\s*#(include|define|if|ifdef|ifndef|else|elif|endif|undef|pragma|error|warning)\b.*$/gm, " ")
    .replace(/\/dts-v1\/\s*;/g, " ")
    .replace(/\/plugin\/\s*;/g, " ");
}

function splitNodeName(name: string): { base: string; unitAddress?: string } {
  const at = name.indexOf("@");
  if (at < 0) return { base: name };
  return { base: name.slice(0, at), unitAddress: name.slice(at + 1) };
}

function extractCompatible(value: string | true): string[] {
  if (value === true) return [];
  return Array.from(value.matchAll(/"([^"]*)"/g), (match) => match[1]!);
}

class DtsParser {
  private pos = 0;

  constructor(private readonly source: string) {}

  parse(): DeviceTreeNode {
    this.skip();
    if (this.peek() !== "/") {
      throw new Error("device tree deve começar pela raiz '/'");
    }
    const head = this.readHead();
    if (head !== "/") throw new Error(`raiz inválida: "${head}"`);
    this.skip();
    this.expect("{");
    const root = this.parseBlock("/");
    this.skip();
    if (this.peek() === ";") this.pos++;
    return root;
  }

  private peek(): string {
    return this.source[this.pos] ?? "";
  }

  private skip(): void {
    while (this.pos < this.source.length && /\s/.test(this.source[this.pos]!)) this.pos++;
  }

  private expect(char: string): void {
    if (this.peek() !== char) {
      throw new Error(`esperado "${char}" na posição ${this.pos}, encontrado "${this.peek()}"`);
    }
    this.pos++;
  }

  private readHead(): string {
    const start = this.pos;
    while (this.pos < this.source.length && !/[\s{;=}]/.test(this.source[this.pos]!)) {
      this.pos++;
    }
    return this.source.slice(start, this.pos);
  }

  private readValue(): string {
    const start = this.pos;
    let inString = false;
    let depth = 0;
    while (this.pos < this.source.length) {
      const char = this.source[this.pos]!;
      if (inString) {
        if (char === '"' && this.source[this.pos - 1] !== "\\") inString = false;
        this.pos++;
        continue;
      }
      if (char === '"') {
        inString = true;
        this.pos++;
        continue;
      }
      if (char === "<" || char === "[" || char === "(") depth++;
      else if (char === ">" || char === "]" || char === ")") depth--;
      else if (char === ";" && depth === 0) break;
      this.pos++;
    }
    return this.source.slice(start, this.pos).trim();
  }

  private parseBlock(name: string): DeviceTreeNode {
    const { base, unitAddress } = splitNodeName(name);
    const node: DeviceTreeNode = {
      name: base,
      unitAddress,
      properties: {},
      compatible: [],
      children: [],
    };

    for (;;) {
      this.skip();
      if (this.pos >= this.source.length) {
        throw new Error(`bloco "${name}" sem '}' de fechamento`);
      }
      if (this.peek() === "}") {
        this.pos++;
        break;
      }

      let head = this.readHead();
      if (!head) throw new Error(`token vazio na posição ${this.pos}`);
      let label: string | undefined;
      const colon = head.indexOf(":");
      if (colon >= 0) {
        label = head.slice(0, colon);
        head = head.slice(colon + 1);
        if (!head) {
          this.skip();
          head = this.readHead();
        }
      }
      this.skip();

      const next = this.peek();
      if (next === "{") {
        this.pos++;
        const child = this.parseBlock(head);
        child.label = label;
        node.children.push(child);
        this.skip();
        if (this.peek() === ";") this.pos++;
      } else if (next === "=") {
        this.pos++;
        const value = this.readValue();
        this.skip();
        this.expect(";");
        node.properties[head] = value;
        if (head === "compatible") node.compatible.push(...extractCompatible(value));
      } else if (next === ";") {
        this.pos++;
        node.properties[head] = true;
      } else {
        throw new Error(
          `token inesperado "${head}" seguido de "${next}" na posição ${this.pos}`,
        );
      }
    }

    return node;
  }
}

/** Interpreta um subconjunto de DTS (nós, propriedades, labels, compatible). */
export function parseDeviceTree(source: string): DeviceTreeNode {
  return new DtsParser(stripDtsComments(source)).parse();
}

/** Busca recursivamente um nó cujo `compatible` contenha o valor exato. */
export function findCompatible(
  node: DeviceTreeNode,
  compatible: string,
): DeviceTreeNode | null {
  if (node.compatible.includes(compatible)) return node;
  for (const child of node.children) {
    const found = findCompatible(child, compatible);
    if (found) return found;
  }
  return null;
}

/** Lista todos os valores de `compatible` da árvore, sem duplicatas. */
export function collectCompatibles(node: DeviceTreeNode): string[] {
  const found = new Set<string>();
  const walk = (current: DeviceTreeNode): void => {
    for (const value of current.compatible) found.add(value);
    for (const child of current.children) walk(child);
  };
  walk(node);
  return Array.from(found).sort();
}

/** Resumo textual de uma árvore para conferência rápida. */
export function describeDeviceTree(root: DeviceTreeNode): string {
  const lines: string[] = [];
  const walk = (node: DeviceTreeNode, depth: number): void => {
    const indent = "  ".repeat(depth);
    const unit = node.unitAddress ? `@${node.unitAddress}` : "";
    const label = node.label ? `${node.label}: ` : "";
    const compat = node.compatible.length ? ` — compatible: ${node.compatible.join(", ")}` : "";
    lines.push(`${indent}${label}${node.name}${unit}${compat}`);
    for (const [key, value] of Object.entries(node.properties)) {
      if (key === "compatible") continue;
      if (value === true) lines.push(`${indent}  ${key};`);
      else lines.push(`${indent}  ${key} = ${value};`);
    }
    for (const child of node.children) walk(child, depth + 1);
  };
  walk(root, 0);
  return lines.join("\n");
}

/** Nós /dev comuns em Linux embarcado (permissões variam por distro/udev). */
export const COMMON_DEV_NODES: readonly DevNodeInfo[] = [
  {
    path: "/dev/ttyUSB0",
    subsystem: "tty/usb-serial",
    description: "Porta serial de conversor USB (FTDI, CP210x, CH340, PL2303).",
    permissions: "root:dialout 0660 (depende da regra udev)",
    notes: "O número pode mudar ao reconectar; prefira symlink estável por serial.",
  },
  {
    path: "/dev/ttyACM0",
    subsystem: "tty/cdc_acm",
    description: "Porta serial CDC ACM (MCU com USB nativo, Arduino, STM32 VCP).",
    permissions: "root:dialout 0660",
    notes: "Se não aparecer, verifique `dmesg` e o driver cdc_acm.",
  },
  {
    path: "/dev/ttyS0",
    subsystem: "tty/serial",
    description: "UART onboard (16550 ou equivalente), console serial em muitas placas.",
    permissions: "root:dialout 0660",
    notes: "Pode estar ocupada pelo console do kernel; confira cmdline/console=.",
  },
  {
    path: "/dev/i2c-1",
    subsystem: "i2c-dev",
    description: "Barramento I2C exposto ao userspace (i2cdetect/i2cget/i2cset).",
    permissions: "root:i2c 0660",
    notes: "Requer módulo i2c-dev; endereços reservados variam por dispositivo.",
  },
  {
    path: "/dev/spidev0.0",
    subsystem: "spidev",
    description: "Dispositivo SPI com chip-select 0 no barramento 0.",
    permissions: "root:spi 0660",
    notes: "Requer overlay/device tree habilitando spidev; modo e clock são do driver.",
  },
  {
    path: "/dev/gpiochip0",
    subsystem: "gpio",
    description: "Controlador GPIO para libgpiod (gpiodetect/gpioinfo/gpioset).",
    permissions: "root:gpio 0660",
    notes: "Linhas podem estar ocupadas por outro driver; gpioinfo mostra o uso.",
  },
  {
    path: "/dev/input/event0",
    subsystem: "input",
    description: "Eventos de entrada (teclado, touchscreen, GPIO keys).",
    permissions: "root:input 0660",
    notes: "Use evtest/evdev; não assuma que event0 é o dispositivo desejado.",
  },
  {
    path: "/dev/video0",
    subsystem: "video4linux",
    description: "Câmera ou capturador V4L2.",
    permissions: "root:video 0660",
    notes: "v4l2-ctl --list-devices mostra a correspondência correta.",
  },
  {
    path: "/dev/mmcblk0",
    subsystem: "block/mmc",
    description: "Cartão SD/eMMC visto como bloco (partições mmcblk0p1 etc.).",
    permissions: "root:disk 0660",
    notes: "Escrever no bloco pode destruir o sistema; confirme o alvo com lsblk.",
  },
  {
    path: "/dev/net/tun",
    subsystem: "net",
    description: "Interface TUN/TAP para VPN e testes de rede.",
    permissions: "root:root 0666 ou 0600 (depende da distro)",
    notes: "Criar interface exige CAP_NET_ADMIN.",
  },
  {
    path: "/dev/bus/usb/001/001",
    subsystem: "usbfs",
    description: "Dispositivo USB cru (usbfs), usado por libusb.",
    permissions: "root:root 0664; udev pode ajustar",
    notes: "Operações USB cruas podem desconectar o dispositivo; use com cautela.",
  },
];

export function devNodes(): readonly DevNodeInfo[] {
  return COMMON_DEV_NODES;
}

function hex4(value: string | number): string {
  const parsed = typeof value === "number"
    ? value
    : Number.parseInt(value.trim().replace(/^0x/i, ""), 16);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 0xffff) {
    throw new Error(`ID USB inválido: ${value}`);
  }
  return parsed.toString(16).padStart(4, "0");
}

/**
 * Gera uma regra udev para dar acesso estável a um dispositivo.
 * A instalação em /etc/udev/rules.d exige sudo e autorização do administrador;
 * sem `authorized=true`, o comando de instalação fica marcado como bloqueado.
 */
export function udevRule(input: UdevRuleInput): UdevRuleResult {
  const vid = hex4(input.vendorId);
  const pid = hex4(input.productId);
  const subsystem = input.subsystem ?? "tty";
  const mode = input.mode ?? "0660";
  if (!/^[0-7]{3,4}$/.test(mode)) throw new Error(`modo udev inválido: ${mode}`);
  const group = input.group ?? "plugdev";
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(group)) throw new Error(`grupo inválido: ${group}`);
  const symlink = input.symlink ?? `ttyM5_${vid}_${pid}`;
  if (!/^[A-Za-z0-9_.-]+$/.test(symlink)) throw new Error(`symlink inválido: ${symlink}`);

  const serialPart = input.serial
    ? `, ATTRS{serial}=="${input.serial.replace(/"/g, "")}"`
    : "";
  const filename = `99-m5-${vid}-${pid}.rules`;
  const content = [
    `# ${filename} — gerado pelo M5 Agent`,
    "# Revise antes de instalar. Requer sudo e autorização do administrador.",
    `SUBSYSTEM=="${subsystem}", ATTRS{idVendor}=="${vid}", ATTRS{idProduct}=="${pid}"${serialPart}, MODE="${mode}", GROUP="${group}", SYMLINK+="${symlink}"`,
    "",
  ].join("\n");

  const realInstall = `sudo install -m 0644 ${filename} /etc/udev/rules.d/${filename} && sudo udevadm control --reload-rules && sudo udevadm trigger`;
  return {
    authorized: input.authorized === true,
    content,
    installCommand: input.authorized
      ? realInstall
      : `# BLOQUEADO (authorized=false): obtenha autorização e execute manualmente:\n# ${realInstall}`,
    verifyCommand: `udevadm info --query=all --name=/dev/${symlink} && ls -l /dev/${symlink}`,
    requiresSudo: true,
    note: input.authorized
      ? "Instalação autorizada: revise o conteúdo, salve como root e recarregue o udev. Nada foi executado por este módulo."
      : "Somente leitura: a regra é exibida como documentação. Nada foi instalado; a instalação exige sudo e consentimento.",
  };
}

function assertSingleLine(value: string, field: string): void {
  if (/[\r\n]/.test(value)) throw new Error(`${field} não pode conter quebra de linha`);
}

/**
 * Gera uma unit systemd hardened. Sem `authorized=true`, devolve o conteúdo
 * para revisão mas não devolve comandos de instalação/habilitação.
 */
export function systemdUnit(input: SystemdUnitInput): SystemdUnitResult {
  if (!/^[A-Za-z0-9_.@-]+$/.test(input.name)) {
    throw new Error(`nome de unit inválido: ${input.name}`);
  }
  assertSingleLine(input.description, "description");
  assertSingleLine(input.execStart, "execStart");
  if (input.workdir) assertSingleLine(input.workdir, "workdir");
  if (input.user) assertSingleLine(input.user, "user");
  if (input.group) assertSingleLine(input.group, "group");

  const after = input.after ?? ["network-online.target"];
  const wants = input.wants ?? ["network-online.target"];
  const restart = input.restart ?? "on-failure";
  const readWrite = input.readWritePaths ?? [];

  const lines = [
    "[Unit]",
    `Description=${input.description}`,
    ...(after.length ? [`After=${after.join(" ")}`] : []),
    ...(wants.length ? [`Wants=${wants.join(" ")}`] : []),
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${input.execStart}`,
    ...(input.workdir ? [`WorkingDirectory=${input.workdir}`] : []),
    ...(input.user ? [`User=${input.user}`] : []),
    ...(input.group ? [`Group=${input.group}`] : []),
    `Restart=${restart}`,
    "RestartSec=5",
    "",
    "# Hardening básico (revise conforme o hardware/serviço)",
    "NoNewPrivileges=true",
    "PrivateTmp=true",
    "ProtectSystem=strict",
    "ProtectHome=true",
    ...(readWrite.length ? [`ReadWritePaths=${readWrite.join(" ")}`] : []),
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ];

  const file = `/etc/systemd/system/${input.name}.service`;
  const commands = [
    `sudo install -m 0644 ${input.name}.service ${file}`,
    "sudo systemctl daemon-reload",
    `sudo systemctl enable --now ${input.name}`,
    `systemctl status ${input.name} --no-pager`,
  ];

  return {
    name: input.name,
    content: lines.join("\n"),
    installCommands: input.authorized ? commands : [],
    requiresSudo: true,
    note: input.authorized
      ? "Instalação autorizada: os comandos abaixo usam sudo. Revise a unit e o ExecStart antes de executar."
      : "Somente leitura: a unit é exibida para revisão. Comandos de instalação/habilitação exigem authorized=true, sudo e consentimento.",
  };
}

/** Comandos libgpiod: leitura sempre; escrita só com autorização. */
export function gpiodCommands(input: GpiodInput): GpiodResult {
  const chip = input.chip.trim();
  if (!/^[A-Za-z0-9_.-]+$/.test(chip)) throw new Error(`chip GPIO inválido: ${chip}`);
  const line = String(input.line).trim();
  if (!/^[A-Za-z0-9_.-]+$/.test(line)) throw new Error(`linha GPIO inválida: ${line}`);

  const readOnly = [
    "gpiodetect",
    `gpioinfo ${chip}`,
    `gpioget ${chip} ${line}`,
    `gpiofind ${line}`,
  ];
  const stateChanging = input.authorized
    ? [`gpioset ${chip} ${line}=${input.value ?? 1}`]
    : [];

  return {
    readOnly,
    stateChanging,
    notes: [
      "libgpiod v2 usa a mesma sintaxe básica `chip linha=valor`; confira `gpioinfo` antes de escrever.",
      input.authorized
        ? "authorized=true: gpioset altera o nível elétrico. Verifique a tensão e o que está conectado à linha."
        : "authorized=false: apenas leitura. Acionar uma linha pode energizar relés, motores ou outros atuadores.",
      "Se a linha estiver ocupada (used), outro driver a controla; não force uso concorrente.",
    ],
  };
}

/** Comandos de diagnóstico somente-leitura no Linux. */
export function linuxDiagnostics(): LinuxCommand[] {
  return [
    {
      command: "uname -a",
      description: "Versão do kernel e arquitetura.",
      readOnly: true,
    },
    {
      command: "dmesg -T | tail -n 80",
      description: "Mensagens recentes do kernel (USB, GPIO, I2C, SPI).",
      readOnly: true,
      needsRoot: true,
    },
    {
      command: "dmesg -w",
      description: "Acompanha mensagens do kernel ao vivo durante o plug/unplug.",
      readOnly: true,
      needsRoot: true,
    },
    {
      command: "lsusb",
      description: "Lista dispositivos USB conectados (VID:PID).",
      readOnly: true,
    },
    {
      command: "lsusb -t",
      description: "Árvore USB com velocidades e classes de driver.",
      readOnly: true,
    },
    {
      command: "lsusb -v -d 0403:6001",
      description: "Descritores detalhados de um VID:PID específico.",
      readOnly: true,
      needsRoot: true,
    },
    {
      command: "lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT,MODEL,SERIAL",
      description: "Discos, partições e modelos (evita confundir o alvo).",
      readOnly: true,
    },
    {
      command: "lsblk -f",
      description: "Sistemas de arquivos, UUIDs e labels.",
      readOnly: true,
    },
    {
      command: "udevadm info --query=all --name=/dev/ttyUSB0",
      description: "Atributos udev do dispositivo (serial, VID/PID, driver).",
      readOnly: true,
    },
    {
      command: "udevadm monitor --udev",
      description: "Observa eventos udev em tempo real.",
      readOnly: true,
    },
    {
      command: "lspci -nnk",
      description: "Dispositivos PCI e drivers em uso.",
      readOnly: true,
    },
    {
      command: "cat /proc/device-tree/model",
      description: "Modelo da placa exposto pelo device tree (quando disponível).",
      readOnly: true,
    },
  ];
}
