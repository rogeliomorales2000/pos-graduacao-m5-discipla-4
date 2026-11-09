import type { CodeSample } from "../types.ts";
import {
  DEFAULT_EDGES,
  DEFAULT_PARAMS,
  composeLanguage,
  stylesFor,
  type Scenario,
} from "./_engine.ts";

const styles = stylesFor("//");
const regions = ["north", "south", "east", "west"];

const scenarios: Scenario[] = [
  {
    id: "summary",
    structure: "readonly-number-array",
    operation: "aggregate",
    algorithm: "reduce",
    instruction:
      "Implemente uma função pura em TypeScript que resume uma lista de números e devolve total, quantidade e média.",
    explanation:
      "O reduce acumula o total sem mutar a entrada; a média trata a lista vazia para evitar divisão por zero.",
    tags: ["pure-function", "reduce"],
    difficulty: "basic",
    render: (c) => {
      const fn = c.name("summarize");
      const data = c.values.join(", ");
      return `interface Summary {
  total: number;
  count: number;
  average: number;
}

function ${fn}(values: readonly number[]): Summary {
  const total = values.reduce((acc, value) => acc + value, 0);
  const count = values.length;
  return { total, count, average: count === 0 ? 0 : total / count };
}

const sample = [${data}];
const summary = ${fn}(sample);
console.log(\`total=\${summary.total} average=\${summary.average.toFixed(2)}\`);
`;
    },
  },
  {
    id: "group-sales",
    structure: "record-array",
    operation: "group-by-region",
    algorithm: "map-accumulator",
    instruction:
      "Agrupe uma lista de vendas por região e calcule o total de cada grupo usando Map, retornando o resultado ordenado.",
    explanation:
      "O Map evita chaves herdadas de Object.prototype e a ordenação final torna a saída estável.",
    tags: ["records", "map", "grouping"],
    difficulty: "intermediate",
    render: (c) => {
      const fn = c.name("groupByRegion");
      const rows = c.values
        .map(
          (amount, i) =>
            `  { id: ${i + 1}, region: "${regions[i % regions.length]}", amount: ${amount} }`,
        )
        .join(",\n");
      const width = `${c.n}px`;
      return `interface Sale {
  id: number;
  region: string;
  amount: number;
}

function ${fn}(sales: readonly Sale[]): Array<[string, number]> {
  const totals = new Map<string, number>();
  for (const sale of sales) {
    totals.set(sale.region, (totals.get(sale.region) ?? 0) + sale.amount);
  }
  return [...totals.entries()].sort((a, b) => b[1] - a[1]);
}

const sales: Sale[] = [
${rows},
];
const widthHint = "${width}";
console.log(widthHint, ${fn}(sales));
`;
    },
  },
  {
    id: "async-retry",
    structure: "promise-callback",
    operation: "retry",
    algorithm: "async-await",
    instruction:
      "Escreva uma função genérica assíncrona com novas tentativas, atraso configurável e erro final descritivo.",
    explanation:
      "O laço aguarda o atraso com Promise e relança o último erro somente após esgotar as tentativas.",
    tags: ["async", "generics", "error-handling"],
    difficulty: "intermediate",
    render: (c) => {
      const fn = c.name("withRetry");
      const attempts = Math.max(2, (c.n % 4) + 2);
      return `async function ${fn}<T>(
  task: () => Promise<T>,
  attempts: number,
  delayMs: number,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw new Error(\`task failed after \${attempts} attempts: \${String(lastError)}\`);
}

async function main(): Promise<void> {
  const value = await ${fn}(async () => ${c.n}, ${attempts}, ${c.n2});
  console.log(\`resolved=\${value} tag=${c.text}\`);
}

void main();
`;
    },
  },
  {
    id: "user-registry",
    structure: "class-map",
    operation: "validate-and-store",
    algorithm: "encapsulation",
    instruction:
      "Implemente uma classe que valida e armazena usuários em um Map privado, expondo consulta e contagem.",
    explanation:
      "Campos privados impedem mutação externa; a validação rejeita e-mails sem arroba e notas fora do intervalo.",
    tags: ["class", "validation", "private-fields"],
    difficulty: "intermediate",
    render: (c) => {
      const cls = c.name("UserRegistry");
      const entries = c.values
        .slice(0, 4)
        .map(
          (score, i) =>
            `    registry.add("user${i + 1}@example.com", ${Math.max(0, Math.min(100, score + 50))});`,
        )
        .join("\n");
      return `class ${cls} {
  readonly #users = new Map<string, { email: string; score: number }>();

  add(email: string, score: number): void {
    if (!email.includes("@")) throw new Error("invalid email");
    if (!Number.isFinite(score) || score < 0 || score > 100) {
      throw new RangeError("score must be between 0 and 100");
    }
    this.#users.set(email.toLowerCase(), { email, score });
  }

  get(email: string): { email: string; score: number } | undefined {
    return this.#users.get(email.toLowerCase());
  }

  get size(): number {
    return this.#users.size;
  }
}

const registry = new ${cls}();
${entries}
console.log(registry.size, registry.get("user1@example.com"), "${c.text}");
`;
    },
  },
  {
    id: "generic-stack",
    structure: "generic-container",
    operation: "stack-operations",
    algorithm: "array-backed",
    instruction:
      "Crie uma pilha genérica com push, pop, peek e tamanho, lançando erro ao remover de uma pilha vazia.",
    explanation:
      "A pilha usa um array interno e métodos tipados; o erro explícito evita retornar undefined silenciosamente.",
    tags: ["generics", "data-structure", "stack"],
    difficulty: "intermediate",
    render: (c) => {
      const cls = c.name("Stack");
      const pushes = c.values
        .slice(0, 5)
        .map((value) => `stack.push(${value});`)
        .join("\n");
      return `class ${cls}<T> {
  private readonly items: T[] = [];

  push(value: T): void {
    this.items.push(value);
  }

  pop(): T {
    const value = this.items.pop();
    if (value === undefined) throw new Error("stack is empty");
    return value;
  }

  peek(): T | undefined {
    return this.items[this.items.length - 1];
  }

  get size(): number {
    return this.items.length;
  }
}

const stack = new ${cls}<number>();
${pushes}
console.log(stack.size, stack.peek(), stack.pop());
`;
    },
  },
  {
    id: "shape-area",
    structure: "discriminated-union",
    operation: "area-calculation",
    algorithm: "pattern-matching",
    instruction:
      "Modele círculos e retângulos como união discriminada e calcule a área com um type guard.",
    explanation:
      "A união discriminada permite que o compilador verifique exhaustivamente cada variante; o guard estreita o tipo em tempo de execução.",
    tags: ["union", "type-guard", "exhaustive"],
    difficulty: "intermediate",
    render: (c) => {
      const fn = c.name("area");
      const guard = c.name("isCircle");
      const radius = Math.max(1, c.n % 9);
      const width = Math.max(1, c.n2 % 11);
      return `type Shape =
  | { kind: "circle"; radius: number }
  | { kind: "rect"; width: number; height: number };

function ${guard}(shape: Shape): shape is Extract<Shape, { kind: "circle" }> {
  return shape.kind === "circle";
}

function ${fn}(shape: Shape): number {
  if (${guard}(shape)) return Math.PI * shape.radius ** 2;
  return shape.width * shape.height;
}

const shapes: Shape[] = [
  { kind: "circle", radius: ${radius} },
  { kind: "rect", width: ${width}, height: ${c.n} },
];
console.log(shapes.map(${fn}), "${c.text}");
`;
    },
  },
  {
    id: "memoize",
    structure: "closure-cache",
    operation: "memoization",
    algorithm: "map-cache",
    instruction:
      "Implemente memoização genérica com Map, preservando o tipo de entrada e contando execuções reais.",
    explanation:
      "O cache fica capturado no closure, portanto cada função memoizada possui seu próprio estado.",
    tags: ["closure", "generics", "cache"],
    difficulty: "intermediate",
    render: (c) => {
      const fn = c.name("memoize");
      const calls = c.values
        .slice(0, 5)
        .map((value) => `square(${value});`)
        .join("\n");
      return `function ${fn}<A extends string | number, R>(compute: (arg: A) => R): (arg: A) => R {
  const cache = new Map<A, R>();
  return (arg: A): R => {
    const cached = cache.get(arg);
    if (cached !== undefined) return cached;
    const value = compute(arg);
    cache.set(arg, value);
    return value;
  };
}

let executions = 0;
const square = ${fn}((value: number): number => {
  executions += 1;
  return value * value;
});
${calls}
console.log(executions, square(${c.n}), "${c.text}");
`;
    },
  },
  {
    id: "binary-search",
    structure: "sorted-array",
    operation: "search",
    algorithm: "binary-search",
    instruction:
      "Implemente busca binária com lower bound sobre um array ordenado e destaque o índice de inserção quando ausente.",
    explanation:
      "O intervalo semiaberto evita off-by-one e devolve o primeiro índice cujo valor é maior ou igual ao alvo.",
    tags: ["binary-search", "sorted", "lower-bound"],
    difficulty: "intermediate",
    render: (c) => {
      const fn = c.name("lowerBound");
      const data = [...c.values].sort((a, b) => a - b).join(", ");
      const target = c.n;
      return `function ${fn}(values: readonly number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (values[middle] < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

const sorted = [${data}].sort((a, b) => a - b);
const index = ${fn}(sorted, ${target});
console.log(index, index < sorted.length ? sorted[index] : "insert-at-end");
`;
    },
  },
  {
    id: "config-parser",
    structure: "key-value-lines",
    operation: "parse-and-validate",
    algorithm: "split-scan",
    instruction:
      "Leia linhas no formato chave=valor, ignore linhas vazias e comentários e valide chaves duplicadas.",
    explanation:
      "O parser normaliza espaços, descarta comentários iniciados por cardinal e rejeita a segunda ocorrência de uma chave.",
    tags: ["parser", "validation", "record"],
    difficulty: "intermediate",
    render: (c) => {
      const fn = c.name("parseConfig");
      const port = 3000 + (c.n % 500);
      return `function ${fn}(input: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of input.split("\\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) throw new Error(\`invalid line: \${line}\`);
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key in result) throw new Error(\`duplicate key: \${key}\`);
    result[key] = value;
  }
  return result;
}

const config = ${fn}("mode=${c.text}\\nport=${port}\\nretries=${c.n2}\\n# ignored\\n");
console.log(config.mode, Number(config.port) + 1);
`;
    },
  },
  {
    id: "median-tests",
    structure: "test-suite",
    operation: "median",
    algorithm: "sorting-and-assertions",
    instruction:
      "Implemente o cálculo de mediana e escreva testes com node:test cobrindo lista ímpar, par e vazia.",
    explanation:
      "Os testes usam node:assert/strict e verificam os três caminhos do algoritmo sem depender de frameworks externos.",
    tags: ["testing", "node-test", "median"],
    difficulty: "intermediate",
    render: (c) => {
      const fn = c.name("median");
      const data = [...c.values].sort((a, b) => a - b);
      const odd = data.length % 2 === 1 ? data[Math.floor(data.length / 2)] : data[0];
      return `import { test } from "node:test";
import assert from "node:assert/strict";

function ${fn}(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

test("median handles odd input", () => {
  assert.equal(${fn}([${data.join(", ")}]), ${odd});
});

test("median handles empty input", () => {
  assert.equal(${fn}([]), 0);
});

test("median keeps duplicate values", () => {
  assert.equal(${fn}([${c.n}, ${c.n}, ${c.n2}, ${c.n2}]), ${(c.n + c.n2) / 2});
});
`;
    },
  },
];

export function generate(): CodeSample[] {
  return composeLanguage({
    language: "ts",
    label: "TypeScript/JavaScript",
    seed: 0x5eed_1001,
    scenarios,
    styles,
    edges: DEFAULT_EDGES,
    params: DEFAULT_PARAMS,
    min: 800,
  });
}
