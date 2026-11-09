import { Tool } from "../core/types";
import { truncate } from "../core/util";
import { runShell } from "./shell";

function enumerationCommand(): { shell: "powershell" | "bash"; command: string } {
  if (process.platform === "win32") {
    return {
      shell: "powershell",
      command: [
        "$ErrorActionPreference='SilentlyContinue'",
        "Write-Output '--- Dispositivos USB (PnP) ---'",
        "Get-PnpDevice -PresentOnly | Where-Object { $_.Class -in @('USB','Ports','HIDClass','Bluetooth','WPD','Image','AndroidUsbDeviceClass') } | Select-Object Status,Class,FriendlyName,InstanceId | Sort-Object Class,FriendlyName | Format-Table -AutoSize | Out-String -Width 240",
        "Write-Output '--- Portas seriais (COM) ---'",
        "Get-CimInstance Win32_SerialPort | Select-Object DeviceID,Name,Description,PNPDeviceID | Format-Table -AutoSize | Out-String -Width 240",
        "Write-Output '--- Dispositivos PnP com ID USB ---'",
        "Get-CimInstance Win32_PnPEntity | Where-Object { $_.PNPDeviceID -like 'USB\\*' } | Select-Object Status,Name,Manufacturer,PNPDeviceID | Format-Table -AutoSize | Out-String -Width 240",
      ].join("; "),
    };
  }
  if (process.platform === "darwin") {
    return {
      shell: "bash",
      command: "system_profiler SPUSBDataType 2>/dev/null | head -n 240",
    };
  }
  return {
    shell: "bash",
    command: [
      "echo '--- USB ---'",
      "lsusb 2>/dev/null || true",
      "echo '--- Portas seriais ---'",
      "ls -l /dev/ttyUSB* /dev/ttyACM* 2>/dev/null || true",
    ].join("; "),
  };
}

export const usbDevicesTool: Tool = {
  spec: {
    name: "usb_devices",
    group: "lab",
    dangerous: false,
    description:
      "Lista dispositivos USB, HID, Bluetooth e portas COM conectados nesta máquina. Somente leitura; não altera drivers nem dispositivos.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  async run(_input, ctx) {
    const { shell, command } = enumerationCommand();
    const result = await runShell({
      command,
      cwd: ctx.workspace,
      timeoutMs: 30_000,
      shell,
    });
    const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
    ctx.log("usb_devices", { code: result.code, timedOut: result.timedOut });
    return {
      ok: !result.timedOut && result.code === 0,
      output: truncate(output || "(nenhum dispositivo USB/COM encontrado)", ctx.config.limits.maxToolOutputChars),
      meta: { code: result.code, timedOut: result.timedOut },
    };
  },
};
