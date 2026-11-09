import { Tool } from "../core/types";
import { readFileTool, writeFileTool, patchFileTool, listDirTool, globTool, grepTool } from "./fs";
import { shellTool } from "./shell";
import { gitTool } from "./git";
import { netProbeTool } from "./net";
import { INDEX_TOOLS } from "./index";
import { usbDevicesTool } from "./usb";

export const BASE_TOOLS: Tool[] = [
  readFileTool,
  writeFileTool,
  patchFileTool,
  listDirTool,
  globTool,
  grepTool,
  ...INDEX_TOOLS,
  usbDevicesTool,
  shellTool,
  gitTool,
  netProbeTool,
];

export function toolByName(name: string): Tool | undefined {
  return BASE_TOOLS.find((t) => t.spec.name === name);
}

/** Descrição compacta para o system prompt. */
export function renderToolCatalog(tools: Tool[] = BASE_TOOLS): string {
  return tools
    .map((tool) => {
      const props = Object.entries(tool.spec.parameters.properties)
        .map(([key, value]) => {
          const required = tool.spec.parameters.required?.includes(key) ? "" : "?";
          return `${key}${required}:${value.type}`;
        })
        .join(", ");
      return `- ${tool.spec.name}(${props}) — ${tool.spec.description}`;
    })
    .join("\n");
}
