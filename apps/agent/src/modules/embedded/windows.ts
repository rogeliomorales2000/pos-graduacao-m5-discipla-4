/**
 * Windows: WinUSB, pnputil, enumeração de portas COM, Get-PnpDevice/devcon e
 * modo de teste de assinatura de driver.
 *
 * Operações que instalam/removem driver, desabilitam dispositivo ou mudam a
 * política de boot exigem administrador e consentimento. Sem `authorized`,
 * o módulo devolve somente comandos de leitura e a explicação.
 */

export interface WindowsCommand {
  command: string;
  description: string;
  requiresAdmin?: boolean;
  changesState?: boolean;
}

export interface PnputilInput {
  authorized?: boolean;
  /** Caminho do INF a instalar. */
  infPath?: string;
  /** INF publicado (oemNN.inf) a remover. */
  oemInf?: string;
  /** Instance ID do dispositivo, ex.: USB\VID_0403&PID_6001\SERIAL. */
  deviceId?: string;
}

export interface PnputilResult {
  readOnly: WindowsCommand[];
  stateChanging: WindowsCommand[];
  notes: string[];
}

export interface DriverTestModeInput {
  authorized: boolean;
  enable: boolean;
}

export interface DriverTestModeResult {
  authorized: boolean;
  requested: "enable" | "disable";
  readOnly: WindowsCommand[];
  stateChanging: WindowsCommand[];
  warnings: string[];
  note: string;
}

/** Notas práticas sobre WinUSB e drivers de dispositivo. */
export function winUsbNotes(): string[] {
  return [
    "WinUSB é o driver genérico para dispositivos vendor-specific (classe 0xFF) que não têm driver de função próprio.",
    "O INF precisa casar o hardware ID (USB\\VID_xxxx&PID_xxxx) e usar Include=winusb.inf / Needs=WINUSB.NT e WINUSB.NT.Services.",
    "Para CDC ACM (classe 0x02/0x02/0x01), o Windows normalmente usa usbser.sys; não substitua por WinUSB sem necessidade.",
    "Conversores USB-serial (FTDI, CP210x, CH340) usam driver VCP do fabricante ou o driver nativo do Windows Update.",
    "Assinatura de driver é obrigatória em produção. Test-signing serve para bancada/VM e exige admin, Secure Boot desligado e reboot.",
    "Não desative a verificação de assinatura de forma permanente nem use `nointegritychecks` em máquina de trabalho.",
    "Use `pnputil /enum-drivers` para descobrir o oemNN.inf antes de remover qualquer driver.",
    "Alterar driver pode interromper teclado, mouse, rede ou armazenamento; tenha um caminho de recuperação.",
  ];
}

const USB_DEVICE_CLASS_GUID = "{88BAE032-5A81-49f0-BC3D-A4FF138216D6}";

/**
 * Modelo de INF para WinUSB. Texto inerte: assinar e instalar é
 * responsabilidade do administrador, com certificado válido.
 */
export function winUsbInfTemplate(input: {
  manufacturer: string;
  deviceName: string;
  vid: string | number;
  pid: string | number;
}): string {
  const vid = typeof input.vid === "number"
    ? input.vid.toString(16).padStart(4, "0")
    : input.vid.replace(/^0x/i, "").padStart(4, "0");
  const pid = typeof input.pid === "number"
    ? input.pid.toString(16).padStart(4, "0")
    : input.pid.replace(/^0x/i, "").padStart(4, "0");
  const safe = (value: string): string => value.replace(/[\r\n"]/g, " ");

  return [
    "; Modelo de INF WinUSB — revise, assine e teste antes de distribuir.",
    "[Version]",
    'Signature="$Windows NT$"',
    "Class=USBDevice",
    `ClassGuid=${USB_DEVICE_CLASS_GUID}`,
    "Provider=%ManufacturerName%",
    "CatalogFile=Device.cat",
    "DriverVer=01/01/2026,1.0.0.0",
    "",
    "[Manufacturer]",
    `%ManufacturerName%=DeviceList,NTamd64`,
    "",
    "[DeviceList.NTamd64]",
    `%DeviceName%=USB_Install, USB\\VID_${vid.toUpperCase()}&PID_${pid.toUpperCase()}`,
    "",
    "[USB_Install]",
    "Include=winusb.inf",
    "Needs=WINUSB.NT",
    "",
    "[USB_Install.Services]",
    "Include=winusb.inf",
    "Needs=WINUSB.NT.Services",
    "",
    "[Strings]",
    `ManufacturerName="${safe(input.manufacturer)}"`,
    `DeviceName="${safe(input.deviceName)}"`,
    "",
  ].join("\n");
}

/**
 * Comandos pnputil corretos (Windows 10 1903+/Windows 11).
 * `stateChanging` só é preenchido com authorized=true.
 */
export function pnputilCommands(input: PnputilInput = {}): PnputilResult {
  const authorized = input.authorized === true;
  const readOnly: WindowsCommand[] = [
    {
      command: "pnputil /enum-devices /connected",
      description: "Lista dispositivos conectados com status e instance ID.",
    },
    {
      command: "pnputil /enum-devices /class Ports",
      description: "Filtra portas COM/LPT e mostra o instance ID.",
    },
    {
      command: "pnputil /enum-devices /problem",
      description: "Mostra dispositivos com problema de driver (código de erro).",
    },
    {
      command: "pnputil /enum-drivers",
      description: "Lista drivers de terceiros publicados como oemNN.inf.",
    },
    {
      command: "pnputil /enum-interfaces \"USB\\VID_0403&PID_6001\" /enabled",
      description: "Lista interfaces habilitadas do dispositivo (quando suportado).",
    },
  ];

  const stateChanging: WindowsCommand[] = [
    {
      command: `pnputil /add-driver "${input.infPath ?? ".\\driver.inf"}" /install`,
      description: "Publica e instala o driver INF no repositório do Windows.",
      requiresAdmin: true,
      changesState: true,
    },
    {
      command: "pnputil /scan-devices",
      description: "Força uma nova varredura de dispositivos.",
      requiresAdmin: true,
      changesState: true,
    },
    {
      command: `pnputil /restart-device "${input.deviceId ?? "USB\\VID_0403&PID_6001\\SERIAL"}"`,
      description: "Reinicia (disable+enable) o dispositivo indicado.",
      requiresAdmin: true,
      changesState: true,
    },
    {
      command: `pnputil /disable-device "${input.deviceId ?? "USB\\VID_0403&PID_6001\\SERIAL"}"`,
      description: "Desabilita o dispositivo; pode derrubar o próprio console.",
      requiresAdmin: true,
      changesState: true,
    },
    {
      command: `pnputil /enable-device "${input.deviceId ?? "USB\\VID_0403&PID_6001\\SERIAL"}"`,
      description: "Reabilita o dispositivo previamente desabilitado.",
      requiresAdmin: true,
      changesState: true,
    },
    {
      command: `pnputil /delete-driver ${input.oemInf ?? "oem42.inf"} /uninstall /force`,
      description: "Remove o driver publicado; /force pode afetar outros dispositivos.",
      requiresAdmin: true,
      changesState: true,
    },
  ];

  return {
    readOnly,
    stateChanging: authorized ? stateChanging : [],
    notes: [
      "Execute o terminal como Administrador para qualquer comando que altere o repositório de drivers.",
      "Confirme o instance ID com pnputil/Get-PnpDevice antes de reiniciar ou desabilitar; um alvo errado pode derrubar o sistema.",
      authorized
        ? "authorized=true: comandos de alteração incluídos. Faça backup do driver com `pnputil /export-driver` antes."
        : "authorized=false: somente leitura. Instalação/remoção/reinício de driver não foram incluídos.",
      "Em Windows 10 anterior a 1903, `pnputil` não tem /enum-devices; use Get-PnpDevice ou atualize.",
    ],
  };
}

/** Enumeração de portas COM por PowerShell/CIM (somente leitura). */
export function comPortEnumeration(): WindowsCommand[] {
  return [
    {
      command: "Get-CimInstance Win32_SerialPort | Select-Object DeviceID,Name,Description,PNPDeviceID",
      description: "Portas seriais vistas pelo WMI/CIM com VID/PID no PNPDeviceID.",
    },
    {
      command: "Get-PnpDevice -Class Ports -PresentOnly | Select-Object Status,Class,FriendlyName,InstanceId",
      description: "Portas presentes via PnP, incluindo portas sem driver funcional.",
    },
    {
      command: "[System.IO.Ports.SerialPort]::GetPortNames()",
      description: "Nomes COM disponíveis para .NET (COM1, COM3...).",
    },
    {
      command: "Get-ItemProperty -Path 'HKLM:\\HARDWARE\\DEVICEMAP\\SERIALCOMM'",
      description: "Mapeamento registro → COM usado pelo driver serial.",
    },
    {
      command: "Get-CimInstance Win32_PnPEntity | Where-Object { $_.Name -match 'COM\\d+' } | Select-Object Name,DeviceID,Status",
      description: "Fallback para portas COM que o Win32_SerialPort não lista.",
    },
  ];
}

/** Diagnóstico PnP com Get-PnpDevice e devcon (somente leitura). */
export function pnpDiagnostics(): WindowsCommand[] {
  return [
    {
      command: "Get-PnpDevice -PresentOnly | Sort-Object Class,FriendlyName | Format-Table -AutoSize",
      description: "Inventário de dispositivos presentes.",
    },
    {
      command: "Get-PnpDevice -Status Error | Format-List *",
      description: "Dispositivos com erro e detalhes do problema.",
    },
    {
      command: "Get-PnpDevice -Class USB -PresentOnly | Select-Object Status,FriendlyName,InstanceId",
      description: "Somente dispositivos USB e seus instance IDs.",
    },
    {
      command: "Get-PnpDeviceProperty -InstanceId 'USB\\VID_0403&PID_6001\\SERIAL' | Format-Table KeyName,Data",
      description: "Propriedades do dispositivo (driver, serviço, localização).",
    },
    {
      command: "devcon status *VID_0403*",
      description: "Status via devcon (ferramenta legada do WDK; não vem no Windows).",
    },
    {
      command: "devcon findall =ports",
      description: "Lista todas as portas conhecidas pelo devcon, inclusive não presentes.",
    },
    {
      command: "Get-WinEvent -LogName 'Microsoft-Windows-Kernel-PnP/Configuration' -MaxEvents 50",
      description: "Eventos recentes de configuração PnP/driver.",
    },
    {
      command: "Get-CimInstance Win32_PnPSignedDriver | Where-Object { $_.DeviceID -like '*VID_0403*' } | Select-Object DeviceName,DriverVersion,DriverProviderName,IsSigned",
      description: "Driver instalado, versão, provedor e assinatura.",
    },
  ];
}

/**
 * Modo de teste de assinatura de driver (`testsigning`).
 *
 * Requer administrador, Secure Boot desligado e reboot. Reduz a proteção do
 * boot: use apenas em VM ou máquina de bancada. `nointegritychecks` não é
 * sugerido. Sem authorized=true, só leitura + explicação.
 */
export function driverTestMode(input: DriverTestModeInput): DriverTestModeResult {
  const readOnly: WindowsCommand[] = [
    {
      command: "bcdedit /enum {current}",
      description: "Mostra a configuração atual do boot (testsigning, nointegritychecks).",
      requiresAdmin: true,
    },
    {
      command: "Confirm-SecureBootUEFI",
      description: "Confirma se o Secure Boot está ativo (true/false).",
      requiresAdmin: true,
    },
    {
      command: "Get-CimInstance Win32_ComputerSystem | Select-Object Manufacturer,Model",
      description: "Identifica se é VM ou hardware físico antes de mexer no boot.",
    },
    {
      command: "Get-CimInstance -ClassName Win32_DeviceGuard -Namespace root\\Microsoft\\Windows\\DeviceGuard",
      description: "Estado de Code Integrity/Device Guard.",
      requiresAdmin: true,
    },
  ];

  const requested: "enable" | "disable" = input.enable ? "enable" : "disable";
  const commands: WindowsCommand[] = input.enable
    ? [
        {
          command: "bcdedit /set testsigning on",
          description: "Habilita o modo de teste de assinatura no próximo boot.",
          requiresAdmin: true,
          changesState: true,
        },
        {
          command: "shutdown /r /t 0",
          description: "Reinicia imediatamente para aplicar (salve o trabalho antes).",
          requiresAdmin: true,
          changesState: true,
        },
      ]
    : [
        {
          command: "bcdedit /set testsigning off",
          description: "Desabilita o modo de teste de assinatura.",
          requiresAdmin: true,
          changesState: true,
        },
        {
          command: "shutdown /r /t 0",
          description: "Reinicia para voltar à política normal.",
          requiresAdmin: true,
          changesState: true,
        },
      ];

  const warnings = [
    "`testsigning` exige administrador, Secure Boot desligado e reboot; o Windows exibe marca d'água no desktop.",
    "Use somente em VM ou máquina de bancada. Em produção, assine o driver com certificado válido (attestation/EV).",
    "Não use `bcdedit /set nointegritychecks on`: isso desativa a verificação de integridade e não é necessário para testar driver.",
    "Se o Secure Boot estiver ativo, desligá-lo é uma decisão do proprietário da máquina e deve ser revertida ao final.",
    "Tenha um ponto de restauração/backup; alterações de boot podem impedir a inicialização.",
  ];

  return {
    authorized: input.authorized === true,
    requested,
    readOnly,
    stateChanging: input.authorized ? commands : [],
    warnings,
    note: input.authorized
      ? `authorized=true: comandos para ${input.enable ? "habilitar" : "desabilitar"} testsigning incluídos. Execute como Administrador e reinicie.`
      : "authorized=false: somente leitura. Alterar testsigning exige autorização explícita, administrador e reboot; nenhum comando de escrita foi retornado.",
  };
}
