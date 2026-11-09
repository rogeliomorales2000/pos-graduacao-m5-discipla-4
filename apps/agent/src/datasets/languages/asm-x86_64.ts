import type { CodeSample } from "../types.ts";
import {
  DEFAULT_EDGES,
  DEFAULT_PARAMS,
  composeLanguage,
  stylesFor,
  type Scenario,
} from "./_engine.ts";

const styles = stylesFor("#");

function dataBlock(c: { values: number[]; n: number }): string {
  return `.section .data
.align 8
sample_values:
    .quad ${c.values.join(", ")}
.equ sample_count, ${c.values.length}
.equ sample_seed, ${c.n}
`;
}

const scenarios: Scenario[] = [
  {
    id: "sum-array",
    structure: "int64-array",
    operation: "sum",
    algorithm: "loop-sysv",
    instruction:
      "Implemente em x86-64 (SysV) uma função que soma um array de int64 usando rdi como ponteiro e rsi como contagem.",
    explanation:
      "O laço avança o ponteiro em 8 bytes e decrementa o contador, retornando o total em rax.",
    tags: ["sysv", "array", "loop"],
    difficulty: "basic",
    render: (c) => {
      const fn = c.name("sum_i64");
      return `.intel_syntax noprefix
.text
.globl ${fn}

# long ${fn}(const long *values, long count)
${fn}:
    xor rax, rax
    test rsi, rsi
    jle .Lsum_done_${fn}
.Lsum_loop_${fn}:
    add rax, qword ptr [rdi]
    add rdi, 8
    dec rsi
    jnz .Lsum_loop_${fn}
.Lsum_done_${fn}:
    ret

${dataBlock(c)}
.section .note.GNU-stack,"",@progbits
`;
    },
  },
  {
    id: "strlen",
    structure: "c-string",
    operation: "length",
    algorithm: "byte-scan",
    instruction:
      "Calcule o comprimento de uma string C em assembly x86-64 sem usar a libc.",
    explanation:
      "O laço compara cada byte com zero e incrementa o índice em rax até encontrar o terminador.",
    tags: ["string", "strlen", "bytes"],
    difficulty: "basic",
    render: (c) => {
      const fn = c.name("strlen_impl");
      return `.intel_syntax noprefix
.text
.globl ${fn}

# size_t ${fn}(const char *text)
${fn}:
    xor rax, rax
.Lstrlen_loop_${fn}:
    cmp byte ptr [rdi + rax], 0
    je .Lstrlen_done_${fn}
    inc rax
    jmp .Lstrlen_loop_${fn}
.Lstrlen_done_${fn}:
    ret

.section .rodata
sample_text:
    .asciz "${c.text}"

${dataBlock(c)}
.section .note.GNU-stack,"",@progbits
`;
    },
  },
  {
    id: "factorial",
    structure: "scalar",
    operation: "factorial",
    algorithm: "multiplicative-loop",
    instruction:
      "Implemente fatorial iterativo em x86-64, tratando 0 e 1 no caminho de saída.",
    explanation:
      "imul acumula em rax enquanto rdi é decrementado; o compare com 2 encerra antes de multiplicar por 1.",
    tags: ["factorial", "loop", "imul"],
    difficulty: "intermediate",
    render: (c) => {
      const fn = c.name("factorial_i64");
      return `.intel_syntax noprefix
.text
.globl ${fn}

# long ${fn}(long value)
${fn}:
    mov rax, 1
    cmp rdi, 2
    jb .Lfact_done_${fn}
.Lfact_loop_${fn}:
    imul rax, rdi
    dec rdi
    cmp rdi, 2
    jae .Lfact_loop_${fn}
.Lfact_done_${fn}:
    ret

${dataBlock(c)}
.section .note.GNU-stack,"",@progbits
`;
    },
  },
  {
    id: "memcpy-words",
    structure: "raw-memory",
    operation: "copy",
    algorithm: "word-loop",
    instruction:
      "Copie palavras de 64 bits entre buffers em assembly, preservando rbp e retornando o destino.",
    explanation:
      "Cada iteração move um qword e avança os dois ponteiros; push/pop mantêm o frame intacto.",
    tags: ["memory", "memcpy", "stack-frame"],
    difficulty: "intermediate",
    render: (c) => {
      const fn = c.name("memcpy_words");
      return `.intel_syntax noprefix
.text
.globl ${fn}

# void *${fn}(void *dest, const void *src, size_t words)
${fn}:
    push rbp
    mov rbp, rsp
    mov rax, rdi
    test rdx, rdx
    je .Lcopy_done_${fn}
.Lcopy_loop_${fn}:
    mov rcx, qword ptr [rsi]
    mov qword ptr [rdi], rcx
    add rsi, 8
    add rdi, 8
    dec rdx
    jnz .Lcopy_loop_${fn}
.Lcopy_done_${fn}:
    pop rbp
    ret

${dataBlock(c)}
.section .note.GNU-stack,"",@progbits
`;
    },
  },
  {
    id: "max-signed",
    structure: "two-scalars",
    operation: "maximum",
    algorithm: "conditional-move",
    instruction:
      "Retorne o maior de dois inteiros assinados usando cmovg, sem desvio.",
    explanation:
      "cmovg copia o segundo argumento apenas quando ele é maior, mantendo o pipeline sem branch.",
    tags: ["cmov", "maximum", "branchless"],
    difficulty: "basic",
    render: (c) => {
      const fn = c.name("max_i64");
      return `.intel_syntax noprefix
.text
.globl ${fn}

# long ${fn}(long left, long right)
${fn}:
    mov rax, rdi
    cmp rsi, rax
    cmovg rax, rsi
    ret

${dataBlock(c)}
.section .note.GNU-stack,"",@progbits
`;
    },
  },
  {
    id: "popcount",
    structure: "bitmask",
    operation: "popcount",
    algorithm: "clear-lowest-bit",
    instruction:
      "Conte bits ligados de um uint64 em assembly usando o truque value & (value - 1).",
    explanation:
      "Cada iteração remove o bit menos significativo e incrementa o contador em rax.",
    tags: ["bitwise", "popcount", "loop"],
    difficulty: "intermediate",
    render: (c) => {
      const fn = c.name("popcount_u64");
      return `.intel_syntax noprefix
.text
.globl ${fn}

# unsigned long ${fn}(unsigned long value)
${fn}:
    xor eax, eax
.Lpop_loop_${fn}:
    test rdi, rdi
    je .Lpop_done_${fn}
    lea rdx, [rdi - 1]
    and rdi, rdx
    inc rax
    jmp .Lpop_loop_${fn}
.Lpop_done_${fn}:
    ret

${dataBlock(c)}
.section .note.GNU-stack,"",@progbits
`;
    },
  },
  {
    id: "strcmp",
    structure: "c-strings",
    operation: "compare",
    algorithm: "byte-difference",
    instruction:
      "Compare duas strings C byte a byte e retorne a diferença assinada na primeira divergência.",
    explanation:
      "A comparação usa extensão sem sinal dos bytes e retorna zero somente ao encontrar o terminador em ambas.",
    tags: ["strcmp", "strings", "signed-result"],
    difficulty: "intermediate",
    render: (c) => {
      const fn = c.name("strcmp_impl");
      return `.intel_syntax noprefix
.text
.globl ${fn}

# int ${fn}(const char *left, const char *right)
${fn}:
.Lcmp_loop_${fn}:
    movzx eax, byte ptr [rdi]
    movzx edx, byte ptr [rsi]
    cmp eax, edx
    jne .Lcmp_diff_${fn}
    test eax, eax
    je .Lcmp_equal_${fn}
    inc rdi
    inc rsi
    jmp .Lcmp_loop_${fn}
.Lcmp_diff_${fn}:
    sub eax, edx
    ret
.Lcmp_equal_${fn}:
    xor eax, eax
    ret

.section .rodata
left_text:
    .asciz "${c.text}"
right_text:
    .asciz "${c.text}"

${dataBlock(c)}
.section .note.GNU-stack,"",@progbits
`;
    },
  },
  {
    id: "write-syscall",
    structure: "process-entry",
    operation: "write-stdout",
    algorithm: "linux-syscall",
    instruction:
      "Escreva uma mensagem em stdout com a syscall write e encerre o processo com exit.",
    explanation:
      "rax recebe o número da syscall, os argumentos vão em rdi/rsi/rdx e o segundo syscall encerra com código zero.",
    tags: ["syscall", "linux", "start"],
    difficulty: "advanced",
    render: (c) => {
      const message = `${c.text} ${c.n}\\n`;
      return `.intel_syntax noprefix
.text
.globl _start

_start:
    mov rax, 1
    mov rdi, 1
    lea rsi, [rip + message]
    mov rdx, message_len
    syscall

    mov rax, 60
    xor rdi, rdi
    syscall

.section .rodata
message:
    .ascii "${message}"
.equ message_len, . - message

${dataBlock(c)}
.section .note.GNU-stack,"",@progbits
`;
    },
  },
  {
    id: "reverse-array",
    structure: "int64-array",
    operation: "reverse",
    algorithm: "two-pointer-swap",
    instruction:
      "Inverta um array de int64 in-place com dois ponteiros e trocas de 8 bytes.",
    explanation:
      "rdi avança e rdx recua até se cruzarem; cada troca usa dois registradores temporários.",
    tags: ["array", "two-pointer", "in-place"],
    difficulty: "intermediate",
    render: (c) => {
      const fn = c.name("reverse_i64");
      return `.intel_syntax noprefix
.text
.globl ${fn}

# void ${fn}(long *values, long count)
${fn}:
    test rsi, rsi
    jle .Lrev_done_${fn}
    lea rdx, [rdi + rsi * 8 - 8]
.Lrev_loop_${fn}:
    cmp rdi, rdx
    jae .Lrev_done_${fn}
    mov rax, qword ptr [rdi]
    mov rcx, qword ptr [rdx]
    mov qword ptr [rdi], rcx
    mov qword ptr [rdx], rax
    add rdi, 8
    sub rdx, 8
    jmp .Lrev_loop_${fn}
.Lrev_done_${fn}:
    ret

${dataBlock(c)}
.section .note.GNU-stack,"",@progbits
`;
    },
  },
  {
    id: "gcd",
    structure: "two-integers",
    operation: "greatest-common-divisor",
    algorithm: "euclid-loop",
    instruction:
      "Implemente o algoritmo de Euclides para MDC usando divisão sem sinal.",
    explanation:
      "O resto fica em rdx após div; o par (divisor, resto) se repete até o resto ser zero.",
    tags: ["gcd", "division", "euclid"],
    difficulty: "advanced",
    render: (c) => {
      const fn = c.name("gcd_i64");
      return `.intel_syntax noprefix
.text
.globl ${fn}

# unsigned long ${fn}(unsigned long left, unsigned long right)
${fn}:
    test rsi, rsi
    je .Lgcd_done_${fn}
.Lgcd_loop_${fn}:
    xor rdx, rdx
    mov rax, rdi
    div rsi
    mov rdi, rsi
    mov rsi, rdx
    test rsi, rsi
    jne .Lgcd_loop_${fn}
.Lgcd_done_${fn}:
    mov rax, rdi
    ret

${dataBlock(c)}
.section .note.GNU-stack,"",@progbits
`;
    },
  },
];

export function generate(): CodeSample[] {
  return composeLanguage({
    language: "asm-x86_64",
    label: "Assembly x86-64 (SysV)",
    seed: 0x5eed_9009,
    scenarios,
    styles,
    edges: DEFAULT_EDGES,
    params: DEFAULT_PARAMS,
    min: 800,
  });
}
