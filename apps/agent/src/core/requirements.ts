import { spawnSync } from "node:child_process";
import path from "node:path";

export interface RequirementRule {
  key: string;
  label: string;
  /** Termos que fazem o requisito aparecer na tarefa. */
  task: RegExp;
  /** Padrões de código real que comprovam a implementação. */
  content: RegExp;
}

/**
 * Requisitos técnicos explícitos que merecem uma checagem determinística.
 *
 * A checagem não tenta entender o pedido inteiro: ela só evita que o modelo
 * entregue um stub (ex.: um socket vazio) quando a tarefa pediu SSH, PTY, FTP,
 * buffer dinâmico e offsets ao mesmo tempo.
 */
export const REQUIREMENT_RULES: RequirementRule[] = [
  {
    key: "pty",
    label: "PTY/terminal interativo",
    task: /\bpty\b|pseudo.?terminal|terminal\s+interativo/i,
    content: /\bpty\b|invoke_shell|open_shell|openpty|forkpty|node-pty|pseudo.?terminal/i,
  },
  {
    key: "ssh",
    label: "SSH",
    task: /\bssh\b/i,
    content: /\bssh\b|paramiko|asyncssh|ssh2|SSHClient|openssh/i,
  },
  {
    key: "ftp",
    label: "FTP/SFTP",
    task: /\b(?:s?ftp)\b/i,
    content: /\b(?:s?ftp)\b|ftplib|pysftp|SFTPClient|FTP\b/i,
  },
  {
    key: "socket",
    label: "socket TCP/UDP",
    task: /\bsocket\b|\btcp\b|\budp\b/i,
    content: /\bsocket\b|SOCK_STREAM|SOCK_DGRAM|create_connection|createServer|net\.connect/i,
  },
  {
    key: "buffer",
    label: "buffer dinâmico",
    task: /\bbuffer\b/i,
    content: /buffer|bytearray|memoryview|BytesIO|deque|readinto|ring.?buffer/i,
  },
  {
    key: "offset",
    label: "mapeamento de offsets",
    task: /\boffsets?\b|\bdeslocamentos?\b/i,
    content: /offset|deslocamento|cursor|seek\(|tell\(|position/i,
  },
  {
    key: "memory",
    label: "leitura/instrumentação de memória",
    task: /\bmem[oó]ria\b|\bmemory\b/i,
    content: /\bmem[oó]ria\b|\bmemory\b|ReadProcessMemory|ptrace|\/proc\/.+?\/mem|mmap|memoryview|ctypes|buffer/i,
  },
  {
    key: "tls",
    label: "TLS/SSL",
    task: /\btls\b|\bssl\b|https/i,
    content: /\btls\b|\bssl\b|SSLContext|create_default_context|wrap_socket/i,
  },
  {
    key: "auth",
    label: "autenticação",
    task: /\bautentica|\bauth\b|\blogin\b|\bsenha\b|\bpassword\b/i,
    content: /auth|login|password|passphrase|credential|key_filename|username/i,
  },
];

const IMPLEMENT_INTENT =
  /\b(adicion\w*|inclu\w*|cri\w*|implement\w*|integr\w*|mont\w*|escrev\w*|ger\w*|corrig\w*|ajust\w*|melhor\w*|refator\w*|refa\w*|reescrev\w*|preciso|quero)\b/i;

const CODE_EXTENSIONS = new Set([
  ".py", ".pyw", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".go", ".rs", ".c", ".h", ".cc", ".cpp", ".hpp", ".cs",
  ".java", ".kt", ".rb", ".php", ".sh", ".bash", ".ps1",
  ".lua", ".swift", ".scala", ".sql",
]);

export function isCodeFile(file: string): boolean {
  return CODE_EXTENSIONS.has(path.extname(file).toLowerCase());
}

/** Requisitos técnicos que aparecem no texto atual do usuário. */
export function extractTaskRequirements(task: string): RequirementRule[] {
  return REQUIREMENT_RULES.filter((rule) => rule.task.test(task));
}

export function requirementLabels(task: string): string[] {
  return extractTaskRequirements(task).map((rule) => rule.label);
}

/**
 * Remove comentários antes de checar cobertura. Sem isso, um comentário
 * "# exemplo SSH" faria o arquivo passar mesmo sem uma linha de SSH.
 */
export function stripComments(content: string, ext: string): string {
  let text = content;
  if (ext === ".py" || ext === ".pyw") {
    text = text.replace(/'''[\s\S]*?'''|"""[\s\S]*?"""/g, "");
    text = text.replace(/#.*$/gm, "");
    return text;
  }
  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".c", ".h", ".cc", ".cpp", ".hpp", ".cs", ".java", ".kt", ".go", ".rs", ".swift", ".scala"].includes(ext)) {
    text = text.replace(/\/\*[\s\S]*?\*\//g, "");
    text = text.replace(/\/\/.*$/gm, "");
  }
  return text;
}

export interface PythonSyntaxCheck {
  available: boolean;
  error: string | null;
}

/**
 * Valida a sintaxe Python via `ast.parse` sem criar arquivos temporários.
 * Se não houver interpretador disponível, retorna available=false e não bloqueia.
 */
export function checkPythonSyntax(content: string): PythonSyntaxCheck {
  const probe = "import ast,sys; ast.parse(sys.stdin.read())";
  const commands = process.platform === "win32" ? ["python", "py"] : ["python3", "python"];
  for (const command of commands) {
    const result = spawnSync(command, ["-c", probe], {
      input: content,
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
    });
    if (result.error) {
      const code = (result.error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue;
      return { available: true, error: result.error.message };
    }
    if (result.status === 0) return { available: true, error: null };
    const detail = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    return {
      available: true,
      error: (detail || `python saiu com código ${result.status}`).slice(0, 1_200),
    };
  }
  return { available: false, error: null };
}

export interface QualityIssue {
  message: string;
  missing: string[];
  tooThin: boolean;
  syntaxError: string | null;
}

/**
 * Barreira de qualidade aplicada antes de aceitar um write_file completo.
 *
 * - Exige implementação real para cada requisito técnico detectado.
 * - Para 2+ requisitos, exige um mínimo de código (não comentário) para evitar
 *   que um stub de 10 linhas seja aceito como solução.
 * - Valida sintaxe de Python quando disponível.
 */
export function validateGeneratedContent(
  task: string,
  file: string,
  content: string,
): QualityIssue | null {
  const ext = path.extname(file).toLowerCase();
  if (!isCodeFile(file)) return null;

  const requirements = extractTaskRequirements(task);
  const code = stripComments(content, ext);
  // Só exige cobertura quando o pedido é de implementação e tem múltiplos
  // requisitos. Tarefas de remoção ("remova SSH e FTP") não devem ser
  // bloqueadas por não conterem mais o recurso removido.
  const enforceCoverage = requirements.length >= 2 && IMPLEMENT_INTENT.test(task);
  const missing = enforceCoverage
    ? requirements.filter((rule) => !rule.content.test(code))
    : [];
  const minChars = enforceCoverage ? 300 + requirements.length * 150 : 0;
  const tooThin = minChars > 0 && code.trim().length < minChars;
  const syntax = (ext === ".py" || ext === ".pyw")
    ? checkPythonSyntax(content)
    : { available: false, error: null as string | null };

  if (missing.length === 0 && !tooThin && !syntax.error) return null;

  const parts: string[] = [];
  if (missing.length > 0) {
    parts.push(`faltam implementações para: ${missing.map((rule) => rule.label).join(", ")}`);
  }
  if (tooThin) {
    parts.push(
      `o código tem ${code.trim().length} caracteres para ${requirements.length} requisitos `
      + `(mínimo sugerido: ${minChars})`,
    );
  }
  if (syntax.error) parts.push(`Python inválido: ${syntax.error}`);

  return {
    message: parts.join("; "),
    missing: missing.map((rule) => rule.key),
    tooThin,
    syntaxError: syntax.error,
  };
}
