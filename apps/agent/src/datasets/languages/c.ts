import type { CodeSample } from "../types.ts";
import {
  DEFAULT_EDGES,
  DEFAULT_PARAMS,
  composeLanguage,
  stylesFor,
  type Scenario,
} from "./_engine.ts";

const styles = stylesFor("//");

const scenarios: Scenario[] = [
  {
    id: "malloc-sum",
    structure: "heap-array",
    operation: "sum",
    algorithm: "malloc-free",
    instruction:
      "Aloque um vetor de inteiros no heap, preencha-o, some os valores e libere a memória.",
    explanation:
      "O retorno de malloc é verificado antes do uso e free acontece exatamente uma vez.",
    tags: ["pointers", "malloc", "free"],
    difficulty: "basic",
    render: (c) => {
      const first = c.values[0] ?? c.number;
      const count = c.values.length;
      return `#include <stdio.h>
#include <stdlib.h>

int main(void) {
    const size_t count = ${count}U;
    int *values = malloc(count * sizeof *values);
    if (values == NULL) {
        return EXIT_FAILURE;
    }

    const int seed = ${first};
    for (size_t i = 0; i < count; i++) {
        values[i] = seed + (int)(i * ${Math.abs(c.n2) + 1}U);
    }

    long long total = 0;
    for (size_t i = 0; i < count; i++) {
        total += values[i];
    }

    printf("total=%lld count=%zu\\n", total, count);
    free(values);
    return EXIT_SUCCESS;
}
`;
    },
  },
  {
    id: "qsort-records",
    structure: "struct-array",
    operation: "sort-by-score",
    algorithm: "qsort-comparator",
    instruction:
      "Defina uma struct de recordes, ordene com qsort por score decrescente e imprima os três primeiros.",
    explanation:
      "O comparador recebe const void * e devolve a diferença inteira esperada por qsort.",
    tags: ["struct", "qsort", "comparator"],
    difficulty: "intermediate",
    render: (c) => {
      const rows = c.values
        .slice(0, 5)
        .map((score, i) => `    { ${i + 1}, ${score} },`)
        .join("\n");
      return `#include <stdio.h>
#include <stdlib.h>

typedef struct {
    int id;
    int score;
} Record;

static int compare_score(const void *left, const void *right) {
    const Record *a = left;
    const Record *b = right;
    if (a->score < b->score) return 1;
    if (a->score > b->score) return -1;
    return a->id - b->id;
}

int main(void) {
    Record records[] = {
${rows}
    };
    const size_t count = sizeof records / sizeof records[0];
    qsort(records, count, sizeof records[0], compare_score);

    for (size_t i = 0; i < count && i < 3; i++) {
        printf("%d:%d\\n", records[i].id, records[i].score);
    }
    return EXIT_SUCCESS;
}
`;
    },
  },
  {
    id: "bit-flags",
    structure: "bitmask",
    operation: "permission-check",
    algorithm: "bitwise-operations",
    instruction:
      "Modele permissões com bits, alterne uma flag com XOR e conte os bits ligados com um laço bitwise.",
    explanation:
      "Os deslocamentos definem máscaras independentes e `value & (value - 1)` remove o bit menos significativo.",
    tags: ["bitwise", "flags", "popcount"],
    difficulty: "intermediate",
    render: (c) => {
      const bit = c.n % 7;
      return `#include <stdint.h>
#include <stdio.h>

#define FLAG_READ  (1u << 0)
#define FLAG_WRITE (1u << 1)
#define FLAG_EXEC  (1u << 2)

static unsigned popcount_u32(uint32_t value) {
    unsigned count = 0;
    while (value != 0u) {
        value &= value - 1u;
        count++;
    }
    return count;
}

int main(void) {
    uint32_t flags = FLAG_READ | FLAG_WRITE | (1u << ${bit});
    flags ^= FLAG_WRITE;

    const int can_read = (flags & FLAG_READ) != 0u;
    printf("flags=%u bits=%u read=%d\\n", flags, popcount_u32(flags), can_read);
    return 0;
}
`;
    },
  },
  {
    id: "file-roundtrip",
    structure: "text-file",
    operation: "write-read",
    algorithm: "stdio-loop",
    instruction:
      "Grave números em um arquivo texto, releia linha a linha com fgets e acumule o total.",
    explanation:
      "O arquivo é fechado antes da leitura e strtol converte cada linha com validação simples.",
    tags: ["files", "stdio", "fgets"],
    difficulty: "intermediate",
    render: (c) => {
      const rows = (c.n % 5) + 2;
      return `#include <stdio.h>
#include <stdlib.h>

int main(void) {
    FILE *file = fopen("records.txt", "w");
    if (file == NULL) {
        return EXIT_FAILURE;
    }
    for (int i = 0; i < ${rows}; i++) {
        fprintf(file, "%d\\n", ${c.values[0] ?? c.number} + i * ${Math.abs(c.n2) + 1});
    }
    fclose(file);

    file = fopen("records.txt", "r");
    if (file == NULL) {
        return EXIT_FAILURE;
    }

    char line[64];
    long total = 0;
    int lines = 0;
    while (fgets(line, sizeof line, file) != NULL) {
        total += strtol(line, NULL, 10);
        lines++;
    }
    fclose(file);
    remove("records.txt");

    printf("lines=%d total=%ld\\n", lines, total);
    return EXIT_SUCCESS;
}
`;
    },
  },
  {
    id: "linked-list",
    structure: "singly-linked-list",
    operation: "push-and-sum",
    algorithm: "pointer-traversal",
    instruction:
      "Implemente uma lista ligada com inserção na cabeça, soma iterativa e liberação completa.",
    explanation:
      "Cada nó é alocado individualmente; a liberação guarda o próximo ponteiro antes de liberar o atual.",
    tags: ["linked-list", "pointers", "ownership"],
    difficulty: "intermediate",
    render: (c) => {
      const pushes = c.values
        .slice(0, 5)
        .map((value) => `    head = push_front(head, ${value});`)
        .join("\n");
      return `#include <stdio.h>
#include <stdlib.h>

typedef struct Node {
    int value;
    struct Node *next;
} Node;

static Node *push_front(Node *head, int value) {
    Node *node = malloc(sizeof *node);
    if (node == NULL) {
        return NULL;
    }
    node->value = value;
    node->next = head;
    return node;
}

static long list_sum(const Node *head) {
    long total = 0;
    for (const Node *node = head; node != NULL; node = node->next) {
        total += node->value;
    }
    return total;
}

static void free_list(Node *head) {
    while (head != NULL) {
        Node *next = head->next;
        free(head);
        head = next;
    }
}

int main(void) {
    Node *head = NULL;
${pushes}
    printf("sum=%ld\\n", list_sum(head));
    free_list(head);
    return EXIT_SUCCESS;
}
`;
    },
  },
  {
    id: "manual-split",
    structure: "mutable-string",
    operation: "tokenize",
    algorithm: "in-place-scan",
    instruction:
      "Separe uma string em tokens por delimitador sem alocar, gravando ponteiros em um vetor de saída.",
    explanation:
      "A varredura troca cada delimitador por '\\0' e registra o início do próximo token.",
    tags: ["strings", "tokenizer", "pointers"],
    difficulty: "intermediate",
    render: (c) => {
      const tokens = [c.text, String(c.n), String(c.n2), "done"];
      return `#include <stdio.h>
#include <string.h>

static size_t split(char *text, char delimiter, char **out, size_t capacity) {
    size_t count = 0;
    char *start = text;
    for (char *cursor = text; ; cursor++) {
        if (*cursor == delimiter || *cursor == '\\0') {
            if (count < capacity) {
                *cursor = '\\0';
                out[count] = start;
                count++;
            }
            if (*cursor == '\\0') break;
            start = cursor + 1;
        }
    }
    return count;
}

int main(void) {
    char input[] = "${tokens.join(":")}";
    char *parts[8];
    const size_t count = split(input, ':', parts, 8);

    for (size_t i = 0; i < count; i++) {
        printf("[%zu]=%s\\n", i, parts[i]);
    }
    printf("tokens=%zu\\n", count);
    return 0;
}
`;
    },
  },
  {
    id: "ring-buffer",
    structure: "ring-buffer",
    operation: "enqueue-dequeue",
    algorithm: "modular-index",
    instruction:
      "Implemente um ring buffer de capacidade fixa com push, pop e verificação de vazio/cheio.",
    explanation:
      "Os índices avançam com módulo da capacidade e o contador distingue cheio de vazio.",
    tags: ["ring-buffer", "queue", "modular"],
    difficulty: "advanced",
    render: (c) => {
      const capacity = Math.max(4, c.values.length);
      const pushes = c.values
        .slice(0, capacity)
        .map((value) => `    printf("push %d -> %d\\n", ${value}, ring_push(&ring, ${value}));`)
        .join("\n");
      return `#include <stdbool.h>
#include <stdio.h>

typedef struct {
    int data[${capacity}];
    size_t head;
    size_t tail;
    size_t count;
} RingBuffer;

static bool ring_push(RingBuffer *ring, int value) {
    if (ring->count == ${capacity}U) return false;
    ring->data[ring->tail] = value;
    ring->tail = (ring->tail + 1U) % ${capacity}U;
    ring->count++;
    return true;
}

static bool ring_pop(RingBuffer *ring, int *out) {
    if (ring->count == 0U) return false;
    *out = ring->data[ring->head];
    ring->head = (ring->head + 1U) % ${capacity}U;
    ring->count--;
    return true;
}

int main(void) {
    RingBuffer ring = { .head = 0, .tail = 0, .count = 0 };
${pushes}

    int value = 0;
    while (ring_pop(&ring, &value)) {
        printf("pop %d\\n", value);
    }
    return 0;
}
`;
    },
  },
  {
    id: "binary-search",
    structure: "sorted-array",
    operation: "search",
    algorithm: "binary-search",
    instruction:
      "Implemente busca binária iterativa sobre um vetor ordenado e retorne -1 quando ausente.",
    explanation:
      "O meio é calculado com low + (high - low) / 2 para evitar overflow e o intervalo é semiaberto.",
    tags: ["binary-search", "sorted", "overflow-safe"],
    difficulty: "intermediate",
    render: (c) => {
      const data = [...c.values].sort((a, b) => a - b).join(", ");
      return `#include <stdio.h>
#include <stddef.h>

static int binary_search(const int *values, size_t count, int target) {
    size_t low = 0;
    size_t high = count;
    while (low < high) {
        const size_t middle = low + (high - low) / 2;
        if (values[middle] < target) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    if (low < count && values[low] == target) return (int)low;
    return -1;
}

int main(void) {
    int values[] = { ${data} };
    const size_t count = sizeof values / sizeof values[0];
    printf("index=%d\\n", binary_search(values, count, ${c.n}));
    return 0;
}
`;
    },
  },
  {
    id: "fnv-checksum",
    structure: "byte-string",
    operation: "checksum",
    algorithm: "fnv1a",
    instruction:
      "Calcule o checksum FNV-1a de uma string tratando cada byte como unsigned.",
    explanation:
      "O cast para uint8_t antes do XOR evita extensão de sinal em plataformas com char assinado.",
    tags: ["hash", "bitwise", "strings"],
    difficulty: "intermediate",
    render: (c) => {
      const seed = c.values[0] ?? c.number;
      return `#include <stdint.h>
#include <stdio.h>

static uint32_t fnv1a(const char *text) {
    uint32_t hash = 2166136261u;
    while (*text != '\\0') {
        hash ^= (uint8_t)*text;
        hash *= 16777619u;
        text++;
    }
    return hash;
}

int main(void) {
    const char *text = "${c.text}-${seed}";
    printf("hash=%u text=%s\\n", fnv1a(text), text);
    return 0;
}
`;
    },
  },
  {
    id: "argv-options",
    structure: "cli-arguments",
    operation: "option-parsing",
    algorithm: "argv-scan",
    instruction:
      "Leia opções curtas e longas de argv, aceite um valor após --name e valide opções desconhecidas.",
    explanation:
      "O laço compara com strcmp e consome o próximo argumento apenas quando existe.",
    tags: ["argv", "cli", "strcmp"],
    difficulty: "intermediate",
    render: (c) => {
      return `#include <stdio.h>
#include <string.h>

int main(int argc, char **argv) {
    int verbose = 0;
    const char *name = "${c.text}";

    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--verbose") == 0 || strcmp(argv[i], "-v") == 0) {
            verbose = 1;
        } else if (strcmp(argv[i], "--name") == 0 && i + 1 < argc) {
            name = argv[++i];
        } else {
            fprintf(stderr, "unknown option: %s\\n", argv[i]);
            return 1;
        }
    }

    printf("name=%s verbose=%d limit=${c.n}\\n", name, verbose);
    return 0;
}
`;
    },
  },
];

export function generate(): CodeSample[] {
  return composeLanguage({
    language: "c",
    label: "C",
    seed: 0x5eed_3003,
    scenarios,
    styles,
    edges: DEFAULT_EDGES,
    params: DEFAULT_PARAMS,
    min: 800,
  });
}
