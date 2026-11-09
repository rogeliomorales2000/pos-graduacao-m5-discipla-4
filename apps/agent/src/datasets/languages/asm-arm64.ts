import type { CodeSample } from "../types.ts";
import {
  DEFAULT_EDGES,
  DEFAULT_PARAMS,
  composeLanguage,
  stylesFor,
  type Scenario,
} from "./_engine.ts";

const styles = stylesFor("//");

function dataBlock(c: { values: number[]; n: number }): string {
  return `.section .data
.align 3
sample_values:
    .xword ${c.values.join(", ")}
.equ sample_count, ${c.values.length}
.equ sample_seed, ${c.n}
`;
}

const scenarios: Scenario[] = [
  {
    id: "sum-array",
    structure: "int64-array",
    operation: "sum",
    algorithm: "aapcs64-loop",
    instruction:
      "Implemente em AArch64 uma função que soma um array int64 usando x0 como ponteiro e x1 como contagem.",
    explanation:
      "O ldr com pós-incremento avança 8 bytes e subs atualiza as flags para o desvio condicional.",
    tags: ["aapcs64", "array", "loop"],
    difficulty: "basic",
    render: (c) => {
      const fn = c.name("sum_i64");
      return `.arch armv8-a
.text
.global ${fn}

// long ${fn}(const long *values, long count)
${fn}:
    mov x2, #0
    cbz x1, .Lsum_done_${fn}
.Lsum_loop_${fn}:
    ldr x3, [x0], #8
    add x2, x2, x3
    subs x1, x1, #1
    b.ne .Lsum_loop_${fn}
.Lsum_done_${fn}:
    mov x0, x2
    ret

${dataBlock(c)}
`;
    },
  },
  {
    id: "strlen",
    structure: "c-string",
    operation: "length",
    algorithm: "byte-scan",
    instruction:
      "Calcule o comprimento de uma string C em AArch64 com ldrb e terminador zero.",
    explanation:
      "O índice x1 cresce até que ldrb carregue zero; o resultado é movido para x0.",
    tags: ["string", "strlen", "ldrb"],
    difficulty: "basic",
    render: (c) => {
      const fn = c.name("strlen_impl");
      return `.arch armv8-a
.text
.global ${fn}

// unsigned long ${fn}(const char *text)
${fn}:
    mov x1, #0
.Lstrlen_loop_${fn}:
    ldrb w2, [x0, x1]
    cbz w2, .Lstrlen_done_${fn}
    add x1, x1, #1
    b .Lstrlen_loop_${fn}
.Lstrlen_done_${fn}:
    mov x0, x1
    ret

.section .rodata
sample_text:
    .asciz "${c.text}"

${dataBlock(c)}
`;
    },
  },
  {
    id: "factorial",
    structure: "scalar",
    operation: "factorial",
    algorithm: "multiplicative-loop",
    instruction:
      "Implemente fatorial iterativo em AArch64, cobrindo valores zero e um.",
    explanation:
      "mul acumula em x1 e b.ge repete enquanto o fator for pelo menos dois.",
    tags: ["factorial", "mul", "loop"],
    difficulty: "intermediate",
    render: (c) => {
      const fn = c.name("factorial_i64");
      return `.arch armv8-a
.text
.global ${fn}

// long ${fn}(long value)
${fn}:
    mov x1, #1
    cmp x0, #2
    b.lt .Lfact_done_${fn}
.Lfact_loop_${fn}:
    mul x1, x1, x0
    sub x0, x0, #1
    cmp x0, #2
    b.ge .Lfact_loop_${fn}
.Lfact_done_${fn}:
    mov x0, x1
    ret

${dataBlock(c)}
`;
    },
  },
  {
    id: "memcpy-words",
    structure: "raw-memory",
    operation: "copy",
    algorithm: "word-loop",
    instruction:
      "Copie palavras de 64 bits em AArch64 preservando x29/x30 no stack frame.",
    explanation:
      "stp/ldp salvam e restauram o frame; o laço copia um xword por iteração.",
    tags: ["memory", "memcpy", "stack-frame"],
    difficulty: "intermediate",
    render: (c) => {
      const fn = c.name("memcpy_words");
      return `.arch armv8-a
.text
.global ${fn}

// void *${fn}(void *dest, const void *src, size_t words)
${fn}:
    stp x29, x30, [sp, #-16]!
    mov x29, sp
    mov x3, x0
    cbz x2, .Lcopy_done_${fn}
.Lcopy_loop_${fn}:
    ldr x4, [x1], #8
    str x4, [x0], #8
    subs x2, x2, #1
    b.ne .Lcopy_loop_${fn}
.Lcopy_done_${fn}:
    mov x0, x3
    ldp x29, x30, [sp], #16
    ret

${dataBlock(c)}
`;
    },
  },
  {
    id: "max-signed",
    structure: "two-scalars",
    operation: "maximum",
    algorithm: "conditional-select",
    instruction:
      "Retorne o maior de dois inteiros assinados em AArch64 usando csel, sem desvio.",
    explanation:
      "cmp atualiza as flags e csel escolhe x1 ou x0 conforme a condição gt.",
    tags: ["csel", "maximum", "branchless"],
    difficulty: "basic",
    render: (c) => {
      const fn = c.name("max_i64");
      return `.arch armv8-a
.text
.global ${fn}

// long ${fn}(long left, long right)
${fn}:
    cmp x1, x0
    csel x0, x1, x0, gt
    ret

${dataBlock(c)}
`;
    },
  },
  {
    id: "popcount",
    structure: "bitmask",
    operation: "popcount",
    algorithm: "clear-lowest-bit",
    instruction:
      "Conte bits ligados de um uint64 em AArch64 com a técnica value & (value - 1).",
    explanation:
      "sub calcula value - 1, and limpa o bit menos significativo e o contador x1 avança.",
    tags: ["bitwise", "popcount", "and"],
    difficulty: "intermediate",
    render: (c) => {
      const fn = c.name("popcount_u64");
      return `.arch armv8-a
.text
.global ${fn}

// unsigned long ${fn}(unsigned long value)
${fn}:
    mov x1, #0
.Lpop_loop_${fn}:
    cbz x0, .Lpop_done_${fn}
    sub x2, x0, #1
    and x0, x0, x2
    add x1, x1, #1
    b .Lpop_loop_${fn}
.Lpop_done_${fn}:
    mov x0, x1
    ret

${dataBlock(c)}
`;
    },
  },
  {
    id: "strcmp",
    structure: "c-strings",
    operation: "compare",
    algorithm: "byte-difference",
    instruction:
      "Compare duas strings C em AArch64 byte a byte e devolva a diferença assinada.",
    explanation:
      "ldrb com pós-incremento lê os dois lados; sub w0 produz o resultado na primeira divergência.",
    tags: ["strcmp", "strings", "ldrb"],
    difficulty: "intermediate",
    render: (c) => {
      const fn = c.name("strcmp_impl");
      return `.arch armv8-a
.text
.global ${fn}

// int ${fn}(const char *left, const char *right)
${fn}:
.Lcmp_loop_${fn}:
    ldrb w2, [x0], #1
    ldrb w3, [x1], #1
    cmp w2, w3
    b.ne .Lcmp_diff_${fn}
    cbz w2, .Lcmp_equal_${fn}
    b .Lcmp_loop_${fn}
.Lcmp_diff_${fn}:
    sub w0, w2, w3
    ret
.Lcmp_equal_${fn}:
    mov w0, #0
    ret

.section .rodata
left_text:
    .asciz "${c.text}"
right_text:
    .asciz "${c.text}"

${dataBlock(c)}
`;
    },
  },
  {
    id: "write-syscall",
    structure: "process-entry",
    operation: "write-stdout",
    algorithm: "linux-syscall",
    instruction:
      "Escreva em stdout com a syscall write do Linux AArch64 e encerre com exit.",
    explanation:
      "x8 recebe o número da syscall e svc #0 transfere o controle ao kernel; adrp/add montam o endereço.",
    tags: ["syscall", "linux", "svc"],
    difficulty: "advanced",
    render: (c) => {
      const message = `${c.text} ${c.n}\\n`;
      return `.arch armv8-a
.text
.global _start

_start:
    mov x0, #1
    adrp x1, message
    add x1, x1, :lo12:message
    mov x2, #message_len
    mov x8, #64
    svc #0

    mov x0, #0
    mov x8, #93
    svc #0

.section .rodata
message:
    .ascii "${message}"
.equ message_len, . - message

${dataBlock(c)}
`;
    },
  },
  {
    id: "reverse-array",
    structure: "int64-array",
    operation: "reverse",
    algorithm: "two-pointer-swap",
    instruction:
      "Inverta um array int64 in-place em AArch64 com dois ponteiros.",
    explanation:
      "O ponteiro esquerdo sobe e o direito desce; ldr/str com pós-incremento realizam a troca.",
    tags: ["array", "two-pointer", "in-place"],
    difficulty: "intermediate",
    render: (c) => {
      const fn = c.name("reverse_i64");
      return `.arch armv8-a
.text
.global ${fn}

// void ${fn}(long *values, long count)
${fn}:
    cbz x1, .Lrev_done_${fn}
    sub x2, x1, #1
    lsl x2, x2, #3
    add x2, x0, x2
.Lrev_loop_${fn}:
    cmp x0, x2
    b.hs .Lrev_done_${fn}
    ldr x3, [x0]
    ldr x4, [x2]
    str x4, [x0], #8
    str x3, [x2], #-8
    b .Lrev_loop_${fn}
.Lrev_done_${fn}:
    ret

${dataBlock(c)}
`;
    },
  },
  {
    id: "gcd",
    structure: "two-integers",
    operation: "greatest-common-divisor",
    algorithm: "euclid-loop",
    instruction:
      "Implemente o MDC de Euclides em AArch64 com divisão e resto via udiv/msub.",
    explanation:
      "msub calcula o resto e o par (divisor, resto) avança até o resto zero.",
    tags: ["gcd", "udiv", "euclid"],
    difficulty: "advanced",
    render: (c) => {
      const fn = c.name("gcd_i64");
      return `.arch armv8-a
.text
.global ${fn}

// unsigned long ${fn}(unsigned long left, unsigned long right)
${fn}:
    cbz x1, .Lgcd_done_${fn}
.Lgcd_loop_${fn}:
    udiv x2, x0, x1
    msub x2, x2, x1, x0
    mov x0, x1
    mov x1, x2
    cbnz x1, .Lgcd_loop_${fn}
.Lgcd_done_${fn}:
    ret

${dataBlock(c)}
`;
    },
  },
];

export function generate(): CodeSample[] {
  return composeLanguage({
    language: "asm-arm64",
    label: "Assembly ARM64 (AAPCS64)",
    seed: 0x5eed_a00a,
    scenarios,
    styles,
    edges: DEFAULT_EDGES,
    params: DEFAULT_PARAMS,
    min: 800,
  });
}
