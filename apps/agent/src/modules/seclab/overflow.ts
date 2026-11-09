/**
 * Laboratório didático de layout de pilha (x86-64).
 *
 * Gera duas variantes de um programa C muito pequeno e os comandos de
 * compilação/inspeção. O laboratório é estritamente local: não há payload de
 * execução, endereço de retorno concreto, automação de exploração nem alvo
 * remoto. O objetivo é entender como compilador e sistema operacional
 * organizam o frame e quais mitigações mudam esse layout.
 */

export interface OverflowLabOptions {
  /** Tamanho do buffer inseguro, em bytes. */
  bufferSize: number;
  /** Mitigações aplicadas ao binário "mitigated". Padrão: true. */
  canary?: boolean;
  nx?: boolean;
  pie?: boolean;
}

export interface MitigationRow {
  name: string;
  description: string;
  /** Como verificar na prática (checksec/readelf/file). */
  howToCheck: string;
  /** Nome exibido pelo checksec, quando aplicável. */
  checksec: string;
  note: string;
  /** Aliases para facilitar integração com relatórios. */
  mitigation?: string;
  howToVerify?: string;
}

export interface OverflowLab {
  bufferSize: number;
  /** Fontes por nome de arquivo. */
  files: {
    "vulnerable.c": string;
    "mitigated.c": string;
  };
  vulnerable: string;
  mitigated: string;
  vulnerableSource: string;
  mitigatedSource: string;
  compile: {
    /** Lista [vulnerável, mitigado], com acesso também por propriedade. */
    gccWsl: CommandList;
    msvc: CommandList;
    gcc: string[];
    msvcCli: string[];
  };
  /** Lista pronta para copiar e colar. */
  commands: {
    gccWsl: CommandList;
    msvc: CommandList;
  };
  gdbScript: string;
  /** Alias curto de gdbScript. */
  gdb: string;
  notes: string[];
}

/** Array de comandos que também expõe .vulnerable/.mitigated. */
export type CommandList = string[] & { vulnerable: string; mitigated: string };

export interface PayloadPlanInput {
  bufferSize: number;
  savedRbp: number;
  /** Padding extra (alinhamento) entre o RBP salvo e o endereço de retorno. */
  alignment: number;
}

export interface PayloadPlan {
  bufferSize: number;
  savedRbp: number;
  alignment: number;
  offsetToReturnAddress: number;
  valid: boolean;
  errors: string[];
  /** O plano descreve apenas preenchimento/layout, não contém endereço. */
  note: string;
}

const MAX_BUFFER = 1_000_000;

function validateBufferSize(bufferSize: number): void {
  if (!Number.isInteger(bufferSize) || bufferSize <= 0 || bufferSize > MAX_BUFFER) {
    throw new Error(`bufferSize deve ser um inteiro entre 1 e ${MAX_BUFFER}`);
  }
}

function vulnerableSource(bufferSize: number): string {
  return `/*
 * vulnerable.c - laboratorio LOCAL de estouro de pilha (x86-64).
 *
 * Uso restrito a uma VM/container descartavel, com alvo local e autorizado.
 * Este arquivo contem uma copia sem limite de proposito, apenas para estudar
 * o layout do frame. Nao ha payload de execucao nem endereco de retorno.
 */
#include <stdio.h>
#include <string.h>

#define LAB_BUFFER_SIZE ${bufferSize}

static void inspect(const char *input) {
    char buffer[LAB_BUFFER_SIZE];
    /* Inseguro de proposito: strcpy nao conhece o tamanho do destino. */
    strcpy(buffer, input);
    printf("recebido: %s\\n", buffer);
}

int main(int argc, char **argv) {
    if (argc != 2) {
        fprintf(stderr, "uso: %s <texto>\\n", argv[0]);
        return 2;
    }
    inspect(argv[1]);
    return 0;
}
`;
}

function mitigatedSource(bufferSize: number): string {
  return `/*
 * mitigated.c - mesma funcao com limite explicito de tamanho.
 *
 * Compare o frame e as protecoes com o binario vulnerable; o objetivo e
 * observar canario, NX, PIE e RELRO em uma compilacao endurecida.
 */
#include <stdio.h>
#include <string.h>

#define LAB_BUFFER_SIZE ${bufferSize}

static void inspect(const char *input) {
    char buffer[LAB_BUFFER_SIZE];
    size_t len = strlen(input);

    if (len >= sizeof(buffer)) {
        fprintf(stderr, "entrada rejeitada: %zu bytes (limite %zu)\\n",
                len, sizeof(buffer) - 1);
        return;
    }

    memcpy(buffer, input, len + 1);
    printf("recebido: %s\\n", buffer);
}

int main(int argc, char **argv) {
    if (argc != 2) {
        fprintf(stderr, "uso: %s <texto>\\n", argv[0]);
        return 2;
    }
    inspect(argv[1]);
    return 0;
}
`;
}

function mitigatedGccFlags(options: Required<OverflowLabOptions>): string {
  const flags = ["-g", "-O2", "-D_FORTIFY_SOURCE=2", "-Wall", "-Wextra"];
  if (options.canary) flags.push("-fstack-protector-strong");
  if (options.pie) flags.push("-fPIE", "-pie");
  else flags.push("-no-pie");
  flags.push(options.nx ? "-Wl,-z,noexecstack" : "-Wl,-z,execstack");
  flags.push("-Wl,-z,relro,-z,now");
  return flags.join(" ");
}

function mitigatedMsvcFlags(options: Required<OverflowLabOptions>): string {
  const flags = ["/nologo", "/Zi", "/O2", "/W4", "/guard:cf"];
  flags.push(options.canary ? "/GS" : "/GS-");
  flags.push(options.pie ? "/DYNAMICBASE" : "/DYNAMICBASE:NO");
  flags.push(options.nx ? "/NXCOMPAT" : "/NXCOMPAT:NO");
  return flags.join(" ");
}

function commandList(vulnerable: string, mitigated: string): CommandList {
  const list = [vulnerable, mitigated] as CommandList;
  list.vulnerable = vulnerable;
  list.mitigated = mitigated;
  return list;
}

/** Comandos de compilação para gcc (WSL/Linux). */
export function gccCommands(options: OverflowLabOptions): { vulnerable: string; mitigated: string } {
  const bufferSize = options.bufferSize;
  validateBufferSize(bufferSize);
  const resolved: Required<OverflowLabOptions> = {
    bufferSize,
    canary: options.canary ?? true,
    nx: options.nx ?? true,
    pie: options.pie ?? true,
  };

  // O binário vulnerável desliga APENAS o canário e o PIE para que o frame
  // seja estável no depurador. Nenhuma outra proteção é removida dele.
  const vulnerable =
    `gcc -g -O0 -fno-stack-protector -no-pie -o vulnerable vulnerable.c`;
  const mitigated =
    `gcc ${mitigatedGccFlags(resolved)} -o mitigated mitigated.c`;
  return { vulnerable, mitigated };
}

/** Comandos de compilação para MSVC (Developer Command Prompt). */
export function msvcCommands(options: OverflowLabOptions): { vulnerable: string; mitigated: string } {
  const bufferSize = options.bufferSize;
  validateBufferSize(bufferSize);
  const resolved: Required<OverflowLabOptions> = {
    bufferSize,
    canary: options.canary ?? true,
    nx: options.nx ?? true,
    pie: options.pie ?? true,
  };

  return {
    vulnerable: "cl /nologo /Zi /Od /GS- /Fe:vulnerable.exe vulnerable.c",
    mitigated: `cl ${mitigatedMsvcFlags(resolved)} /Fe:mitigated.exe mitigated.c`,
  };
}

export function generateOverflowLab(options: OverflowLabOptions): OverflowLab {
  const bufferSize = options.bufferSize;
  validateBufferSize(bufferSize);
  const resolved: Required<OverflowLabOptions> = {
    bufferSize,
    canary: options.canary ?? true,
    nx: options.nx ?? true,
    pie: options.pie ?? true,
  };

  const vulnerable = vulnerableSource(bufferSize);
  const mitigated = mitigatedSource(bufferSize);
  const gcc = gccCommands(resolved);
  const msvc = msvcCommands(resolved);
  const gccList = commandList(gcc.vulnerable, gcc.mitigated);
  const msvcList = commandList(msvc.vulnerable, msvc.mitigated);

  const gdbScript = `# Roteiro gdb/pwndbg - execute dentro da VM local do laboratorio.
set pagination off
set confirm off
file ./vulnerable

# Para na entrada de inspect e mostra o frame atual.
break inspect
run AAAA

info registers rbp rsp rip
info frame
# pwndbg: use "stack" e "telescope $rsp 32" para visualizar o frame.
x/24gx $rsp

# Avance ate a instrucao de retorno e observe o endereco salvo.
# Nao ha endereco concreto nem payload neste roteiro.
disassemble /m inspect
continue

quit
`;

  return {
    bufferSize,
    files: { "vulnerable.c": vulnerable, "mitigated.c": mitigated },
    vulnerable,
    mitigated,
    vulnerableSource: vulnerable,
    mitigatedSource: mitigated,
    compile: {
      gccWsl: gccList,
      msvc: msvcList,
      gcc: [...gccList],
      msvcCli: [...msvcList],
    },
    commands: {
      gccWsl: gccList,
      msvc: msvcList,
    },
    gdbScript,
    gdb: gdbScript,
    notes: [
      "Laboratório estritamente local: rode em VM/container descartável e sem dados reais.",
      "O binário vulnerable usa -fno-stack-protector (e -no-pie) só para didática; o mitigated mantém as proteções escolhidas.",
      "Nenhuma variante contém payload executável, endereço de retorno concreto ou automação de exploração.",
      "Use checksec --file=./vulnerable e checksec --file=./mitigated para comparar as mitigações.",
      `Buffer do laboratório: ${bufferSize} bytes. O offset de layout é calculado por payloadPlan(), não por tentativa e erro.`,
      "MSVC não oferece FORTIFY_SOURCE; use o build gcc/WSL para observar essa mitigação.",
    ],
  };
}

/** Explica o frame x86-64 de forma genérica (sem endereços concretos). */
export function explainStackFrame(bufferSize = 64): string {
  const size = Number.isInteger(bufferSize) && bufferSize > 0 ? bufferSize : 64;
  return `# Layout do frame (x86-64, didático)

A pilha cresce para endereços menores. Ao entrar em uma função, o prólogo
salva o RBP antigo e reserva espaço para variáveis locais:

  endereço maior
  +---------------------------+
  | argumentos / caller frame |
  +---------------------------+
  | endereço de retorno       |  <- o que o offset de layout alcança
  +---------------------------+
  | RBP salvo                 |  <- 8 bytes (x86-64)
  +---------------------------+
  | canário (se habilitado)   |  <- muda o offset efetivo
  +---------------------------+
  | buffer[${size}]             |  <- RSP aponta para cá na entrada
  +---------------------------+
  endereço menor

O offset até o endereço de retorno é bufferSize + savedRbp + alignment.
Com canário, o compilador insere bytes adicionais entre o buffer e o RBP
salvo; por isso o valor observado no depurador pode ser maior. Use
payloadPlan() apenas para estudar essa aritmética. Não há endereço concreto,
payload ou alvo remoto neste laboratório.`;
}

/** Calcula o offset de layout e recusa valores negativos/inválidos. */
export function payloadPlan(input: PayloadPlanInput): PayloadPlan {
  const { bufferSize, savedRbp, alignment } = input;
  const errors: string[] = [];

  if (!Number.isInteger(bufferSize) || bufferSize < 0) {
    errors.push("bufferSize deve ser um inteiro não-negativo");
  }
  if (!Number.isInteger(savedRbp) || savedRbp < 0) {
    errors.push("savedRbp deve ser um inteiro não-negativo");
  }
  if (!Number.isInteger(alignment) || alignment < 0) {
    errors.push("alignment deve ser um inteiro não-negativo");
  }

  const offsetToReturnAddress = bufferSize + savedRbp + alignment;
  if (!Number.isFinite(offsetToReturnAddress) || offsetToReturnAddress < 0) {
    errors.push("offsetToReturnAddress não pode ser negativo");
  }

  return {
    bufferSize,
    savedRbp,
    alignment,
    offsetToReturnAddress,
    valid: errors.length === 0,
    errors,
    note:
      "O offset descreve preenchimento até o endereço de retorno. " +
      "Não inclui endereço, payload ou técnica de execução.",
  };
}

export function assertPayloadPlan(input: PayloadPlanInput): PayloadPlan {
  const plan = payloadPlan(input);
  if (!plan.valid) {
    throw new Error(`Plano de layout inválido: ${plan.errors.join("; ")}`);
  }
  return plan;
}

/** Tabela de mitigações com foco em observação local via checksec. */
export function mitigationsTable(): MitigationRow[] {
  const rows: MitigationRow[] = [
    {
      name: "ASLR",
      description:
        "Randomiza bases de pilha, bibliotecas e (com PIE) o executável a cada execução.",
      howToCheck:
        "cat /proc/sys/kernel/randomize_va_space (2 = ativo no Linux); no gdb, rode duas vezes e compare $rsp.",
      checksec: "não aparece como coluna; é uma configuração do kernel",
      note: "Não desative no host real. Se necessário, use apenas uma VM descartável.",
    },
    {
      name: "NX",
      description:
        "Marca páginas de pilha/dados como não executáveis (GNU_STACK sem permissão X).",
      howToCheck:
        "checksec --file=./mitigated; readelf -l ./mitigated | grep GNU_STACK; procure 'RW' sem 'E'.",
      checksec: "NX",
      note: "O binário vulnerable é apenas para observar o frame; NX continua ativo no kernel.",
    },
    {
      name: "Stack Canary",
      description:
        "Insere um valor sentinela antes do RBP salvo e aborta se ele for alterado.",
      howToCheck:
        "checksec --file=./mitigated; readelf -s ./mitigated | grep __stack_chk_fail; compare o frame das duas variantes.",
      checksec: "Canary",
      note: "O vulnerable é compilado com -fno-stack-protector de propósito.",
    },
    {
      name: "PIE",
      description:
        "Compila o executável como posição-independente, permitindo randomizar sua base.",
      howToCheck:
        "checksec --file=./mitigated; file ./mitigated; readelf -h ./mitigated | grep Type (DYN = PIE).",
      checksec: "PIE",
      note: "O vulnerable usa -no-pie para manter o layout estável no gdb.",
    },
    {
      name: "RELRO",
      description:
        "Torna a GOT somente leitura depois da resolução dinâmica (full RELRO com BIND_NOW).",
      howToCheck:
        "checksec --file=./mitigated; readelf -l ./mitigated | grep GNU_RELRO; readelf -d ./mitigated | grep BIND_NOW.",
      checksec: "RELRO",
      note: "Full RELRO é o alvo didático do build mitigated.",
    },
    {
      name: "FORTIFY_SOURCE",
      description:
        "Faz o compilador trocar funções inseguras por variantes com verificação de tamanho.",
      howToCheck:
        "Compile o mitigated com -D_FORTIFY_SOURCE=2 -O2 e procure símbolos *_chk: readelf -s ./mitigated | grep _chk.",
      checksec: "não aparece como coluna; é uma mitigação de compilação",
      note: "Não existe equivalente direto no MSVC; use o build gcc/WSL.",
    },
  ];

  return rows.map((row) => ({
    ...row,
    mitigation: row.name,
    howToVerify: row.howToCheck,
  }));
}
