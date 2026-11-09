import type { CodeSample } from "../types.ts";
import {
  DEFAULT_EDGES,
  DEFAULT_PARAMS,
  composeLanguage,
  stylesFor,
  type Scenario,
} from "./_engine.ts";

const styles = stylesFor("#");

const scenarios: Scenario[] = [
  {
    id: "dataclass-summary",
    structure: "dataclass",
    operation: "aggregate",
    algorithm: "sum-and-guard",
    instruction:
      "Implemente uma dataclass imutável e uma função que resume uma lista de números com média segura.",
    explanation:
      "A dataclass frozen torna o resultado imutável e a média verifica a lista vazia antes de dividir.",
    tags: ["dataclass", "pure-function"],
    difficulty: "basic",
    render: (c) => {
      const data = c.values.join(", ");
      return `from dataclasses import dataclass


@dataclass(frozen=True)
class Summary:
    total: float
    count: int
    average: float


def summarize(values: list[float]) -> Summary:
    total = float(sum(values))
    count = len(values)
    average = total / count if count else 0.0
    return Summary(total=total, count=count, average=average)


if __name__ == "__main__":
    result = summarize([${data}])
    print(f"total={result.total} average={result.average:.2f}")
`;
    },
  },
  {
    id: "generator-pipeline",
    structure: "iterator-pipeline",
    operation: "filter-and-accumulate",
    algorithm: "generators",
    instruction:
      "Crie geradores preguiçosos que filtram valores positivos e produzem o total acumulado.",
    explanation:
      "Cada gerador consome o anterior sem materializar listas intermediárias, mantendo o custo de memória constante.",
    tags: ["generator", "lazy", "iterator"],
    difficulty: "intermediate",
    render: (c) => {
      const data = c.values.join(", ");
      return `from collections.abc import Iterable, Iterator


def positives(values: Iterable[int]) -> Iterator[int]:
    for value in values:
        if value > 0:
            yield value


def running_total(values: Iterable[int]) -> Iterator[int]:
    total = 0
    for value in values:
        total += value
        yield total


if __name__ == "__main__":
    data = [${data}]
    print(list(running_total(positives(data))))
`;
    },
  },
  {
    id: "argparse-cli",
    structure: "command-line",
    operation: "argument-parsing",
    algorithm: "argparse",
    instruction:
      "Construa uma CLI com argparse que valida um contador positivo e imprime um rótulo configurável.",
    explanation:
      "O parser declara tipos e padrões; a função main aceita argv injetável, o que facilita testes.",
    tags: ["cli", "argparse", "validation"],
    difficulty: "intermediate",
    render: (c) => {
      const count = (c.n % 9) + 1;
      return `import argparse


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Generate ${c.text} report")
    parser.add_argument("--count", type=int, default=${count})
    parser.add_argument("--name", default="${c.text}")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.count < 1:
        parser.error("--count must be positive")
    print(f"{args.name}:{args.count}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
`;
    },
  },
  {
    id: "asyncio-gather",
    structure: "job-list",
    operation: "concurrent-execution",
    algorithm: "asyncio-gather",
    instruction:
      "Execute jobs assíncronos com asyncio.gather, atrasos distintos e coleta ordenada dos resultados.",
    explanation:
      "gather preserva a ordem das corrotinas mesmo com atrasos diferentes e propaga a primeira exceção.",
    tags: ["asyncio", "concurrency", "dataclass"],
    difficulty: "advanced",
    render: (c) => {
      const jobs = (c.n % 4) + 2;
      return `import asyncio
from dataclasses import dataclass


@dataclass(frozen=True)
class Job:
    name: str
    delay: float


async def run_job(job: Job) -> str:
    await asyncio.sleep(job.delay)
    return f"{job.name}:{job.delay:.2f}"


async def main() -> None:
    jobs = [Job(f"job-{index}", index * 0.01) for index in range(${jobs})]
    results = await asyncio.gather(*(run_job(job) for job in jobs))
    print(results, "${c.text}")


if __name__ == "__main__":
    asyncio.run(main())
`;
    },
  },
  {
    id: "unittest-chunk",
    structure: "test-suite",
    operation: "chunking",
    algorithm: "unittest",
    instruction:
      "Implemente chunk de listas e cubra o caminho feliz e o erro de tamanho inválido com unittest.",
    explanation:
      "O fatiamento gera blocos sem mutar a entrada; o teste de exceção documenta a pré-condição.",
    tags: ["unittest", "testing", "slices"],
    difficulty: "intermediate",
    render: (c) => {
      const size = (c.n % 3) + 1;
      const data = c.values.join(", ");
      const chunks: number[][] = [];
      for (let i = 0; i < c.values.length; i += size) chunks.push(c.values.slice(i, i + size));
      const expected = chunks.map((chunk) => `[${chunk.join(", ")}]`).join(", ");
      return `import unittest


def chunk(values: list[int], size: int) -> list[list[int]]:
    if size < 1:
        raise ValueError("size must be positive")
    return [values[index:index + size] for index in range(0, len(values), size)]


class ChunkTests(unittest.TestCase):
    def test_chunks(self) -> None:
        self.assertEqual(chunk([${data}], ${size}), [${expected}])

    def test_invalid_size(self) -> None:
        with self.assertRaises(ValueError):
            chunk([], 0)


if __name__ == "__main__":
    unittest.main()
`;
    },
  },
  {
    id: "counter-grouping",
    structure: "frequency-map",
    operation: "grouping",
    algorithm: "counter",
    instruction:
      "Agrupe valores por frequência com collections.Counter e devolva os mais comuns com limite.",
    explanation:
      "Counter evita um dicionário manual e most_common ordena primeiro por contagem e depois por inserção.",
    tags: ["collections", "grouping", "counter"],
    difficulty: "basic",
    render: (c) => {
      const data = c.values.join(", ");
      return `from collections import Counter
from collections.abc import Iterable


def frequency(values: Iterable[int]) -> dict[int, int]:
    return dict(Counter(values))


def most_common(values: Iterable[int], limit: int) -> list[tuple[int, int]]:
    if limit < 1:
        raise ValueError("limit must be positive")
    return Counter(values).most_common(limit)


if __name__ == "__main__":
    data = [${data}]
    print(frequency(data), most_common(data, ${(c.n % 4) + 1}))
`;
    },
  },
  {
    id: "binary-search",
    structure: "sorted-list",
    operation: "search",
    algorithm: "recursive-binary-search",
    instruction:
      "Implemente busca binária recursiva com limites explícitos e retorno -1 quando o alvo não existe.",
    explanation:
      "A cada chamada o intervalo é reduzido à metade; os limites fechados evitam recursão infinita.",
    tags: ["binary-search", "recursion"],
    difficulty: "intermediate",
    render: (c) => {
      const data = [...c.values].sort((a, b) => a - b).join(", ");
      const target = c.n;
      return `def binary_search(
    values: list[int],
    target: int,
    low: int = 0,
    high: int | None = None,
) -> int:
    if high is None:
        high = len(values) - 1
    if low > high:
        return -1
    middle = (low + high) // 2
    if values[middle] == target:
        return middle
    if values[middle] < target:
        return binary_search(values, target, middle + 1, high)
    return binary_search(values, target, low, middle - 1)


if __name__ == "__main__":
    sorted_values = sorted([${data}])
    print(sorted_values, binary_search(sorted_values, ${target}))
`;
    },
  },
  {
    id: "context-report",
    structure: "file-context",
    operation: "temporary-report",
    algorithm: "context-manager",
    instruction:
      "Crie um context manager que grava um relatório temporário, entrega o Path e remove o arquivo no final.",
    explanation:
      "O bloco finally garante a limpeza mesmo se o consumidor lançar uma exceção dentro do with.",
    tags: ["context-manager", "files", "cleanup"],
    difficulty: "intermediate",
    render: (c) => {
      const data = c.values.join(", ");
      return `from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path


@contextmanager
def report_file(path: Path, rows: list[int]) -> Iterator[Path]:
    path.write_text("\\n".join(str(row) for row in rows) + "\\n", encoding="utf-8")
    try:
        yield path
    finally:
        path.unlink(missing_ok=True)


if __name__ == "__main__":
    with report_file(Path("${c.text}-report.txt"), [${data}]) as generated:
        lines = generated.read_text(encoding="utf-8").splitlines()
        print(len(lines), lines[0])
`;
    },
  },
  {
    id: "retry-decorator",
    structure: "decorator",
    operation: "retry",
    algorithm: "higher-order-function",
    instruction:
      "Implemente um decorador de retry com número de tentativas, atraso e preservação de metadados.",
    explanation:
      "functools.wraps mantém nome e docstring; o último erro é encadeado com raise ... from.",
    tags: ["decorator", "retry", "higher-order"],
    difficulty: "advanced",
    render: (c) => {
      const attempts = (c.n % 3) + 2;
      return `import functools
import time
from collections.abc import Callable
from typing import TypeVar

T = TypeVar("T")


def retry(attempts: int, delay: float) -> Callable[[Callable[[], T]], Callable[[], T]]:
    if attempts < 1:
        raise ValueError("attempts must be positive")

    def decorate(func: Callable[[], T]) -> Callable[[], T]:
        @functools.wraps(func)
        def wrapper() -> T:
            last_error: RuntimeError | None = None
            for attempt in range(1, attempts + 1):
                try:
                    return func()
                except RuntimeError as error:
                    last_error = error
                    if attempt < attempts:
                        time.sleep(delay)
            raise RuntimeError(f"failed after {attempts} attempts") from last_error

        return wrapper

    return decorate


@retry(${attempts}, 0.01)
def flaky() -> int:
    return ${c.n}


if __name__ == "__main__":
    print(flaky(), "${c.text}")
`;
    },
  },
  {
    id: "protocol-ranking",
    structure: "protocol-generic",
    operation: "ranking",
    algorithm: "sorting-with-key",
    instruction:
      "Defina um Protocol com atributo score e uma função genérica que retorna os k melhores itens.",
    explanation:
      "O Protocol descreve a estrutura mínima esperada e o TypeVar mantém o tipo concreto na saída.",
    tags: ["protocol", "generics", "sorting"],
    difficulty: "advanced",
    render: (c) => {
      const scores = c.magnitudes.slice(0, 4);
      const players = scores
        .map((score, i) => `    Player("player${i + 1}", ${score}),`)
        .join("\n");
      return `from collections.abc import Iterable
from typing import Protocol, TypeVar

T = TypeVar("T", bound="Scored")


class Scored(Protocol):
    score: int


class Player:
    def __init__(self, name: str, score: int) -> None:
        self.name = name
        self.score = score

    def __repr__(self) -> str:
        return f"Player({self.name!r}, {self.score})"


def top_k(items: Iterable[T], limit: int) -> list[T]:
    if limit < 1:
        raise ValueError("limit must be positive")
    return sorted(items, key=lambda item: item.score, reverse=True)[:limit]


if __name__ == "__main__":
    players = [
${players}
    ]
    print(top_k(players, ${(c.n % 3) + 1}), "${c.text}")
`;
    },
  },
];

export function generate(): CodeSample[] {
  return composeLanguage({
    language: "py",
    label: "Python",
    seed: 0x5eed_2002,
    scenarios,
    styles,
    edges: DEFAULT_EDGES,
    params: DEFAULT_PARAMS,
    min: 800,
  });
}
