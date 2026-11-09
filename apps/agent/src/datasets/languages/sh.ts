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
    id: "find-xargs-lines",
    structure: "file-tree",
    operation: "count-lines",
    algorithm: "find-xargs-awk",
    instruction:
      "Conte linhas de arquivos .log em uma árvore com find -print0, xargs -0 e agregação com awk.",
    explanation:
      "O fluxo NUL suporta nomes com espaços e o awk ignora a linha de total produzida por wc.",
    tags: ["find", "xargs", "awk"],
    difficulty: "intermediate",
    render: (c) => {
      return `set -euo pipefail

root="$1"
if [[ -z "$root" ]]; then
  root="."
fi

find "$root" -type f -name '*.log' -print0 \\
  | xargs -0 -r wc -l \\
  | awk -v limit=${c.n} '$1 ~ /^[0-9]+$/ && $1 > limit { total += $1 } END { printf "lines=%d\\n", total }'
`;
    },
  },
  {
    id: "awk-aggregate",
    structure: "colon-records",
    operation: "aggregate",
    algorithm: "awk",
    instruction:
      "Agregue registros separados por dois-pontos com awk, filtrando por um limite e calculando contagem e soma.",
    explanation:
      "O awk recebe o limite por -v, portanto não há interpolação insegura dentro do programa.",
    tags: ["awk", "aggregate", "filter"],
    difficulty: "basic",
    render: (c) => {
      const regions = ["north", "south", "east", "west"];
      const rows = c.magnitudes
        .slice(0, 6)
        .map((value, i) => `  "${regions[i % regions.length]}:${value}"`)
        .join(" \\\n");
      return `set -euo pipefail

limit=${(c.n % 7) + 2}
printf '%s\\n' \\
${rows} \\
  | awk -F: -v limit="$limit" '$2 >= limit { count += 1; sum += $2 } END { printf "count=%d sum=%d\\n", count, sum }'
`;
    },
  },
  {
    id: "sed-rewrite",
    structure: "key-value-lines",
    operation: "rewrite",
    algorithm: "sed-extended-regex",
    instruction:
      "Reescreva linhas chave=valor no formato chave -> valor com sed e ordene a saída.",
    explanation:
      "A expressão regular usa âncoras e grupos de captura; o sort torna a saída determinística.",
    tags: ["sed", "regex", "sort"],
    difficulty: "basic",
    render: (c) => {
      const port = 3000 + (c.n % 500);
      return `set -euo pipefail

printf '%s\\n' \\
  "mode=${c.text}" \\
  "port=${port}" \\
  "retries=${c.n2}" \\
  | sed -E 's/^([a-z]+)=(.+)$/\\1 -> \\2/' \\
  | sort
`;
    },
  },
  {
    id: "xargs-parallel",
    structure: "work-items",
    operation: "parallel-execution",
    algorithm: "xargs-parallel",
    instruction:
      "Gere itens de trabalho e processe em paralelo com xargs -P, imprimindo cada item.",
    explanation:
      "xargs agrupa os itens por linha e o bash -c recebe o item como primeiro argumento.",
    tags: ["xargs", "parallel", "pipeline"],
    difficulty: "intermediate",
    render: (c) => {
      return `set -euo pipefail

seq 1 ${(c.n % 6) + 3} \\
  | xargs -n 1 -P ${(c.n % 3) + 2} bash -c 'printf "item=%s\\n" "$1"' _
`;
    },
  },
  {
    id: "getopts-cli",
    structure: "cli-options",
    operation: "parse-options",
    algorithm: "getopts",
    instruction:
      "Implemente uma CLI com getopts aceitando -v e -n VALOR, rejeitando opções desconhecidas.",
    explanation:
      "O OPTARG carrega o valor de -n e o shift remove as opções antes dos argumentos posicionais.",
    tags: ["getopts", "cli", "validation"],
    difficulty: "intermediate",
    render: (c) => {
      const count = (c.n % 9) + 1;
      return `set -euo pipefail

verbose=0
count=${count}
while getopts ":vn:" option; do
  case "$option" in
    v) verbose=1 ;;
    n) count="$OPTARG" ;;
    *) printf 'invalid option: %s\\n' "$option" >&2; exit 2 ;;
  esac
done
shift $((OPTIND - 1))

printf 'verbose=%d count=%s args=%s\\n' "$verbose" "$count" "$*"
`;
    },
  },
  {
    id: "trap-cleanup",
    structure: "temporary-workspace",
    operation: "cleanup",
    algorithm: "trap-exit",
    instruction:
      "Crie um diretório temporário, grave um relatório e remova tudo com trap no EXIT.",
    explanation:
      "O trap executa mesmo em erro com set -e, garantindo que o diretório temporário não fique para trás.",
    tags: ["trap", "cleanup", "mktemp"],
    difficulty: "intermediate",
    render: (c) => {
      const rows = (c.n % 5) + 2;
      return `set -euo pipefail

workdir="$(mktemp -d)"
cleanup() {
  rm -rf "$workdir"
}
trap cleanup EXIT

report="$workdir/report.txt"
for index in $(seq 1 ${rows}); do
  printf 'row=%s value=%s\\n' "$index" "$((index * ${c.n2}))" >> "$report"
done
wc -l "$report"
`;
    },
  },
  {
    id: "config-reader",
    structure: "config-file",
    operation: "parse-key-value",
    algorithm: "read-loop",
    instruction:
      "Leia um arquivo de configuração chave=valor, ignore vazios e comentários e reimprima os pares.",
    explanation:
      "IFS restrito ao sinal de igual preserva espaços no valor, e o read retorna falso no fim do arquivo.",
    tags: ["read", "config", "shell"],
    difficulty: "basic",
    render: (c) => {
      const port = 8000 + (c.n % 300);
      return `set -euo pipefail

config="$(mktemp)"
trap 'rm -f "$config"' EXIT
printf '%s\\n' \\
  "mode=${c.text}" \\
  "retries=${c.n}" \\
  "# ignored comment" \\
  "port=${port}" > "$config"

while IFS='=' read -r key value; do
  [[ -z "$key" || "$key" == "#"* ]] && continue
  printf '%s=%s\\n' "$key" "$value"
done < "$config"
`;
    },
  },
  {
    id: "json-field",
    structure: "json-line",
    operation: "extract-fields",
    algorithm: "grep-cut",
    instruction:
      "Extraia campos name e count de uma linha JSON simples usando grep -o e cut, sem dependências externas.",
    explanation:
      "O padrão de grep isola apenas os campos desejados e cut seleciona o valor entre aspas ou após os dois-pontos.",
    tags: ["json", "grep", "cut"],
    difficulty: "basic",
    render: (c) => {
      return `set -euo pipefail

json='{"name":"${c.text}","count":${c.n},"region":"south"}'
name="$(printf '%s\\n' "$json" | grep -o '"name":"[^"]*"' | cut -d'"' -f4)"
count="$(printf '%s\\n' "$json" | grep -o '"count":[0-9]*' | cut -d: -f2)"

printf 'name=%s count=%s\\n' "$name" "$count"
`;
    },
  },
  {
    id: "log-rotation",
    structure: "log-file",
    operation: "rotate",
    algorithm: "size-threshold",
    instruction:
      "Grave entradas em um log temporário e rotacione o arquivo quando passar de um limite de linhas.",
    explanation:
      "O teste compara a contagem atual com o limite e a rotação usa mv seguido de truncamento.",
    tags: ["logs", "rotation", "wc"],
    difficulty: "intermediate",
    render: (c) => {
      const threshold = (c.n % 6) + 3;
      const entries = threshold + 4;
      return `set -euo pipefail

logdir="$(mktemp -d)"
trap 'rm -rf "$logdir"' EXIT
logfile="$logdir/app.log"

for index in $(seq 1 ${entries}); do
  printf 'entry=%s\\n' "$index" >> "$logfile"
done

if [[ "$(wc -l < "$logfile")" -gt ${threshold} ]]; then
  mv "$logfile" "$logfile.1"
  : > "$logfile"
fi

printf 'active=%s archived=%s\\n' "$(wc -l < "$logfile")" "$(wc -l < "$logfile.1")"
`;
    },
  },
  {
    id: "background-workers",
    structure: "worker-set",
    operation: "parallel-wait",
    algorithm: "background-jobs",
    instruction:
      "Dispare workers em background e aguarde todos terminarem antes de imprimir o resumo.",
    explanation:
      "O wait sem argumentos aguarda todos os jobs do shell atual; os subshells isolam cada worker.",
    tags: ["jobs", "background", "wait"],
    difficulty: "intermediate",
    render: (c) => {
      const workers = (c.n % 4) + 2;
      return `set -euo pipefail

workers=${workers}
for index in $(seq 1 "$workers"); do
  (
    sleep 0.01
    printf 'worker %s finished\\n' "$index"
  ) &
done

wait
printf 'workers=%s tag=${c.text}\\n' "$workers"
`;
    },
  },
];

export function generate(): CodeSample[] {
  return composeLanguage({
    language: "sh",
    label: "Shell/Bash",
    seed: 0x5eed_5005,
    scenarios,
    styles,
    edges: DEFAULT_EDGES,
    params: DEFAULT_PARAMS,
    min: 800,
  });
}
