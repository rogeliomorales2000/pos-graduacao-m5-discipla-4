import fs from "node:fs";
import path from "node:path";
import { Authorization, assertInScope } from "./scope";

/**
 * Checklist de reconhecimento autorizado.
 *
 * O módulo NÃO executa comandos: apenas monta um roteiro revisável. Qualquer
 * chamada exige uma autorização vigente e um alvo coberto pelo escopo.
 */

export type ReconKind = "web" | "host" | "rede" | "network" | "dispositivo" | "device";
export type NormalizedReconKind = "web" | "host" | "network" | "device";
export type ToolName = "nmap" | "curl" | "openssl" | "git";
export type ToolAvailability = Record<ToolName, boolean>;

export interface ReconItem {
  id: string;
  title: string;
  command: string;
  /** O que a saída revela e como interpretar. */
  reveals: string;
  tool: string;
  mode: "passivo" | "ativo";
  note?: string;
}

export interface ReconChecklist {
  target: string;
  kind: NormalizedReconKind;
  authorizationId: string;
  authorizationRef: string;
  generatedAt: string;
  tools: ToolAvailability;
  items: ReconItem[];
  warnings: string[];
}

export interface ReconChecklistInput {
  authorization: Authorization;
  target: string;
  kind: ReconKind;
}

function normalizeKind(kind: string): NormalizedReconKind {
  const value = String(kind).trim().toLowerCase();
  if (value === "web") return "web";
  if (value === "host") return "host";
  if (value === "rede" || value === "network" || value === "net") return "network";
  if (value === "dispositivo" || value === "device") return "device";
  throw new Error(`Tipo de recon inválido: "${kind}" (use web, host, rede ou dispositivo)`);
}

function executableExtensions(): string[] {
  if (process.platform !== "win32") return [""];
  return (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
    .split(";")
    .map((ext) => ext.trim())
    .filter(Boolean);
}

/** Localiza um executável no PATH sem executar nada. */
export function findExecutable(name: string): string | null {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const extensions = executableExtensions();
  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = path.join(dir, `${name}${ext}`);
      try {
        if (!fs.statSync(candidate).isFile()) continue;
        if (process.platform !== "win32") fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // Ignora diretórios inexistentes/sem permissão.
      }
    }
  }
  return null;
}

/** Checa nmap, curl, openssl e git no PATH. */
export function toolAvailability(): ToolAvailability {
  return {
    nmap: findExecutable("nmap") !== null,
    curl: findExecutable("curl") !== null,
    openssl: findExecutable("openssl") !== null,
    git: findExecutable("git") !== null,
  };
}

function webTarget(target: string): string {
  return /^https?:\/\//i.test(target) ? target.replace(/\/+$/, "") : `http://${target.replace(/\/+$/, "")}`;
}

function hostPart(target: string): string {
  try {
    return new URL(webTarget(target)).hostname;
  } catch {
    return target.split("/")[0]?.split(":")[0] ?? target;
  }
}

function webItems(target: string): ReconItem[] {
  const base = webTarget(target);
  const host = hostPart(target);
  return [
    {
      id: "web-headers",
      title: "Cabeçalhos HTTP e redirecionamentos",
      command: `curl -sS -D - -o /dev/null ${base}/`,
      reveals:
        "Status, servidor, tecnologias declaradas, cookies e políticas de segurança (HSTS, CSP, X-Frame-Options).",
      tool: "curl",
      mode: "passivo",
    },
    {
      id: "web-robots",
      title: "robots.txt",
      command: `curl -sS ${base}/robots.txt`,
      reveals: "Caminhos que o site declara não querer indexar (não são, por si só, vulnerabilidades).",
      tool: "curl",
      mode: "passivo",
    },
    {
      id: "web-security-txt",
      title: "security.txt",
      command: `curl -sS ${base}/.well-known/security.txt`,
      reveals: "Canal de contato de segurança e política de divulgação responsável.",
      tool: "curl",
      mode: "passivo",
    },
    {
      id: "web-tls",
      title: "Certificado e versão TLS",
      command: `openssl s_client -connect ${host}:443 -servername ${host} </dev/null`,
      reveals: "Emissor, validade, SANs e versão/cifra negociada. Use apenas se houver HTTPS no escopo.",
      tool: "openssl",
      mode: "passivo",
      note: "No PowerShell, redirecione $null em vez de /dev/null.",
    },
  ];
}

function hostItems(target: string): ReconItem[] {
  const host = hostPart(target);
  return [
    {
      id: "host-top-ports",
      title: "Serviços nas portas mais comuns",
      command: `nmap -Pn -sV --top-ports 100 ${host}`,
      reveals: "Portas abertas, serviços e versões declaradas. Base para priorizar revisão manual.",
      tool: "nmap",
      mode: "ativo",
    },
    {
      id: "host-web-ports",
      title: "Portas web usuais",
      command: `nmap -Pn -sT -p 80,443,8000,8080,8443 ${host}`,
      reveals: "Presença de interfaces HTTP/HTTPS alternativas que merecem inspeção.",
      tool: "nmap",
      mode: "ativo",
    },
    {
      id: "host-tls",
      title: "TLS do host",
      command: `openssl s_client -connect ${host}:443 -servername ${host} </dev/null`,
      reveals: "Configuração TLS e cadeia de certificados, quando a porta 443 estiver no escopo.",
      tool: "openssl",
      mode: "passivo",
    },
    {
      id: "host-http",
      title: "Resposta HTTP básica",
      command: `curl -sS -D - -o /dev/null http://${host}/`,
      reveals: "Disponibilidade e cabeçalhos do serviço web padrão, se existir.",
      tool: "curl",
      mode: "passivo",
    },
  ];
}

function networkItems(target: string): ReconItem[] {
  return [
    {
      id: "net-list",
      title: "Listar alvos sem sondar",
      command: `nmap -sL ${target}`,
      reveals: "Quais endereços serão considerados; útil para conferir se o recorte bate com o escopo.",
      tool: "nmap",
      mode: "passivo",
    },
    {
      id: "net-discovery",
      title: "Descoberta de hosts",
      command: `nmap -sn ${target}`,
      reveals: "Hosts ativos na sub-rede autorizada, sem varredura de portas.",
      tool: "nmap",
      mode: "ativo",
    },
    {
      id: "net-services",
      title: "Serviços críticos na sub-rede",
      command: `nmap -Pn -sT -p 22,80,443,445,3389 ${target}`,
      reveals: "Exposição de SSH, HTTP(S), SMB e RDP nos hosts do recorte.",
      tool: "nmap",
      mode: "ativo",
      note: "Prefira alvos individuais ou recortes pequenos para não gerar ruído excessivo.",
    },
    {
      id: "net-top-ports",
      title: "Top portas por host",
      command: `nmap -Pn --top-ports 50 ${target}`,
      reveals: "Superfície resumida por host; combine com inventário e dono do ativo.",
      tool: "nmap",
      mode: "ativo",
    },
  ];
}

function deviceItems(target: string): ReconItem[] {
  const serial = target.replace(/^device:/i, "");
  return [
    {
      id: "dev-list",
      title: "Dispositivos conectados",
      command: "adb devices -l",
      reveals: "Serials, estado de autorização USB e modelo declarado.",
      tool: "adb",
      mode: "passivo",
    },
    {
      id: "dev-model",
      title: "Modelo e versão do Android",
      command: `adb -s ${serial} shell getprop ro.product.model`,
      reveals: "Modelo do dispositivo, para correlacionar com o inventário autorizado.",
      tool: "adb",
      mode: "passivo",
    },
    {
      id: "dev-build",
      title: "Versão e patch de segurança",
      command: `adb -s ${serial} shell getprop ro.build.version.security_patch`,
      reveals: "Nível de patch declarado pelo sistema; não substitui análise de vulnerabilidades.",
      tool: "adb",
      mode: "passivo",
    },
    {
      id: "dev-debug",
      title: "Estado de depuração",
      command: `adb -s ${serial} shell getprop ro.debuggable`,
      reveals: "Se a build é debuggable; em produção o esperado é 0.",
      tool: "adb",
      mode: "passivo",
    },
    {
      id: "dev-packages",
      title: "Pacotes de terceiros",
      command: `adb -s ${serial} shell pm list packages -3`,
      reveals: "Aplicativos instalados fora do sistema, para revisão de inventário e atualizações.",
      tool: "adb",
      mode: "passivo",
      note: "Não execute comandos com root nem altere o dispositivo.",
    },
  ];
}

export function buildReconChecklist(
  authorization: Authorization,
  target: string,
  kind: ReconKind,
): ReconChecklist;
export function buildReconChecklist(input: ReconChecklistInput): ReconChecklist;
export function buildReconChecklist(
  authorizationOrInput: Authorization | ReconChecklistInput,
  target?: string,
  kind?: ReconKind,
): ReconChecklist {
  const auth =
    "authorization" in authorizationOrInput
      ? (authorizationOrInput as ReconChecklistInput).authorization
      : (authorizationOrInput as Authorization);
  const requestedTarget =
    target ?? (authorizationOrInput as ReconChecklistInput).target;
  const requestedKind =
    kind ?? (authorizationOrInput as ReconChecklistInput).kind;

  if (!requestedTarget || !requestedKind) {
    throw new Error("recon exige target e kind");
  }

  // Barreira de segurança: valida janela e cobertura do escopo.
  const match = assertInScope(auth, requestedTarget);
  const normalizedKind = normalizeKind(requestedKind);
  const tools = toolAvailability();

  const items =
    normalizedKind === "web"
      ? webItems(requestedTarget)
      : normalizedKind === "host"
        ? hostItems(requestedTarget)
        : normalizedKind === "network"
          ? networkItems(requestedTarget)
          : deviceItems(requestedTarget);

  const warnings: string[] = [];
  if (!tools.nmap && items.some((item) => item.tool === "nmap")) {
    warnings.push("nmap não encontrado no PATH; os comandos de porta/serviço não poderão ser executados.");
  }
  if (!tools.curl && items.some((item) => item.tool === "curl")) {
    warnings.push("curl não encontrado no PATH; os comandos HTTP não poderão ser executados.");
  }
  if (!tools.openssl && items.some((item) => item.tool === "openssl")) {
    warnings.push("openssl não encontrado no PATH; a inspeção TLS não poderá ser executada.");
  }
  if (items.some((item) => item.tool === "adb")) {
    warnings.push("Os comandos de dispositivo exigem adb instalado e o aparelho já autorizado por USB.");
  }
  warnings.push(
    `Este checklist é apenas um roteiro. Execução real só é permitida dentro do escopo ${auth.authorizationRef} (${match.kind}:${match.value}).`,
  );

  return {
    target: requestedTarget,
    kind: normalizedKind,
    authorizationId: auth.id,
    authorizationRef: auth.authorizationRef,
    generatedAt: new Date().toISOString(),
    tools,
    items,
    warnings,
  };
}

/** Alias em português/curto. */
export const reconChecklist = buildReconChecklist;

/** Renderiza o checklist em Markdown, sem executar nada. */
export function renderReconChecklist(checklist: ReconChecklist): string {
  const lines: string[] = [
    `# Checklist de recon — ${checklist.target}`,
    "",
    `- Tipo: **${checklist.kind}**`,
    `- Autorização: ${checklist.authorizationId} (${checklist.authorizationRef})`,
    `- Gerado em: ${checklist.generatedAt}`,
    "",
    "## Ferramentas",
    "",
    `- nmap: ${checklist.tools.nmap ? "disponível" : "ausente"}`,
    `- curl: ${checklist.tools.curl ? "disponível" : "ausente"}`,
    `- openssl: ${checklist.tools.openssl ? "disponível" : "ausente"}`,
    `- git: ${checklist.tools.git ? "disponível" : "ausente"}`,
    "",
    "## Passos",
    "",
  ];

  for (const item of checklist.items) {
    lines.push(`### ${item.title}`);
    lines.push("");
    lines.push(`- Modo: ${item.mode}`);
    lines.push(`- Ferramenta: ${item.tool}`);
    lines.push(`- Revela: ${item.reveals}`);
    if (item.note) lines.push(`- Nota: ${item.note}`);
    lines.push("");
    lines.push("```text");
    lines.push(item.command);
    lines.push("```");
    lines.push("");
  }

  if (checklist.warnings.length > 0) {
    lines.push("## Avisos");
    lines.push("");
    for (const warning of checklist.warnings) lines.push(`- ${warning}`);
    lines.push("");
  }
  return lines.join("\n");
}
