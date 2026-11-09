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
    id: "raii-file",
    structure: "raii-wrapper",
    operation: "write-file",
    algorithm: "constructor-destructor",
    instruction:
      "Crie um wrapper RAII para escrita em arquivo que valida a abertura no construtor e fecha no destrutor.",
    explanation:
      "O std::ofstream fecha automaticamente no destrutor, portanto exceções não vazam o descritor.",
    tags: ["raii", "files", "exceptions"],
    difficulty: "intermediate",
    render: (c) => {
      const cls = c.name("FileWriter");
      return `#include <fstream>
#include <iostream>
#include <stdexcept>
#include <string>

class ${cls} {
public:
    explicit ${cls}(const std::string& path) : out_(path) {
        if (!out_) {
            throw std::runtime_error("cannot open " + path);
        }
    }

    void write_line(const std::string& line) {
        out_ << line << '\\n';
    }

private:
    std::ofstream out_;
};

int main() {
    try {
        ${cls} writer("${c.text}.txt");
        writer.write_line("count=${c.count}");
        writer.write_line("reference=${c.n}");
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\\n';
        return 1;
    }
    return 0;
}
`;
    },
  },
  {
    id: "template-accumulate",
    structure: "generic-function",
    operation: "sum",
    algorithm: "template",
    instruction:
      "Implemente uma função template que soma um std::vector de qualquer tipo numérico usando std::accumulate.",
    explanation:
      "O template preserva o tipo de retorno e evita conversões implícitas desnecessárias.",
    tags: ["template", "generics", "accumulate"],
    difficulty: "intermediate",
    render: (c) => {
      const data = c.values.join(", ");
      return `#include <iostream>
#include <numeric>
#include <vector>

template <typename T>
T total_of(const std::vector<T>& values) {
    return std::accumulate(values.begin(), values.end(), T{});
}

int main() {
    const std::vector<long long> values{ ${data} };
    const auto total = total_of(values);
    std::cout << "total=" << total << " tag=${c.text}" << '\\n';
    return 0;
}
`;
    },
  },
  {
    id: "stl-transform",
    structure: "stl-vector",
    operation: "sort-and-scale",
    algorithm: "stl-algorithms",
    instruction:
      "Ordene um vetor, aplique uma transformação multiplicativa com lambda e imprima o resultado.",
    explanation:
      "std::sort e std::transform operam in-place e a lambda captura o fator por valor.",
    tags: ["stl", "lambda", "sort"],
    difficulty: "basic",
    render: (c) => {
      const data = c.values.join(", ");
      return `#include <algorithm>
#include <iostream>
#include <vector>

int main() {
    std::vector<int> values{ ${data} };
    const int factor = ${Math.max(2, c.n % 9)};

    std::sort(values.begin(), values.end());
    std::transform(values.begin(), values.end(), values.begin(), [factor](int value) {
        return value * factor;
    });

    for (const int value : values) {
        std::cout << value << ' ';
    }
    std::cout << "\\ncount=" << values.size() << '\\n';
    return 0;
}
`;
    },
  },
  {
    id: "unique-ptr-chain",
    structure: "ownership-chain",
    operation: "build-and-sum",
    algorithm: "move-semantics",
    instruction:
      "Construa uma cadeia de nós com std::unique_ptr, transfira a posse com std::move e some os valores.",
    explanation:
      "unique_ptr expressa posse exclusiva; o retorno por valor move a cadeia sem cópia profunda.",
    tags: ["unique_ptr", "move", "ownership"],
    difficulty: "advanced",
    render: (c) => {
      const count = Math.min(5, c.values.length);
      const values = c.values.slice(0, count);
      return `#include <iostream>
#include <memory>
#include <vector>

struct Node {
    int value;
    std::unique_ptr<Node> next;
    explicit Node(int value) : value(value) {}
};

std::unique_ptr<Node> build_chain() {
    std::unique_ptr<Node> head;
    for (int value : std::vector<int>{ ${values.join(", ")} }) {
        auto node = std::make_unique<Node>(value);
        node->next = std::move(head);
        head = std::move(node);
    }
    return head;
}

int main() {
    const auto head = build_chain();
    long long total = 0;
    for (const Node* node = head.get(); node != nullptr; node = node->next.get()) {
        total += node->value;
    }
    std::cout << "sum=" << total << " max=${c.n}" << '\\n';
    return 0;
}
`;
    },
  },
  {
    id: "unordered-group",
    structure: "hash-map",
    operation: "group-totals",
    algorithm: "unordered-map",
    instruction:
      "Agrupe pares região/valor em um std::unordered_map e imprima os totais por região.",
    explanation:
      "operator[] cria o acumulador na primeira ocorrência e o laço final apenas lê o mapa.",
    tags: ["unordered_map", "grouping", "stl"],
    difficulty: "intermediate",
    render: (c) => {
      const regions = ["north", "south", "east", "west"];
      const rows = c.values
        .slice(0, 6)
        .map((value, i) => `        {"${regions[i % regions.length]}", ${value}},`)
        .join("\n");
      return `#include <iostream>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

int main() {
    const std::vector<std::pair<std::string, long long>> sales{
${rows}
    };

    std::unordered_map<std::string, long long> totals;
    for (const auto& [region, amount] : sales) {
        totals[region] += amount;
    }

    for (const auto& [region, total] : totals) {
        std::cout << region << '=' << total << '\\n';
    }
    return 0;
}
`;
    },
  },
  {
    id: "optional-parse",
    structure: "optional-result",
    operation: "parse-integer",
    algorithm: "from-chars",
    instruction:
      "Converta string_view em inteiro com std::from_chars, rejeitando lixo e overflow via std::optional.",
    explanation:
      "from_chars não lança exceção; a comparação do ponteiro final garante que toda a entrada foi consumida.",
    tags: ["optional", "from_chars", "validation"],
    difficulty: "intermediate",
    render: (c) => {
      return `#include <charconv>
#include <iostream>
#include <optional>
#include <string_view>
#include <system_error>

std::optional<int> parse_int(std::string_view text) {
    int value = 0;
    const auto [end, error] = std::from_chars(text.data(), text.data() + text.size(), value);
    if (error != std::errc{} || end != text.data() + text.size()) {
        return std::nullopt;
    }
    return value;
}

int main() {
    const std::string_view input = "${c.n}";
    if (const auto parsed = parse_int(input)) {
        std::cout << "value=" << *parsed + ${c.n2} << '\\n';
    } else {
        std::cout << "invalid=" << input << '\\n';
    }
    return 0;
}
`;
    },
  },
  {
    id: "string-view-split",
    structure: "string-view",
    operation: "split",
    algorithm: "single-pass",
    instruction:
      "Divida uma string em string_views por delimitador sem copiar os trechos.",
    explanation:
      "Os views apontam para o buffer original, que permanece vivo durante todo o uso.",
    tags: ["string_view", "split", "zero-copy"],
    difficulty: "intermediate",
    render: (c) => {
      const input = [c.text, String(c.n), String(c.n2), "end"].join(":");
      return `#include <iostream>
#include <string>
#include <string_view>
#include <vector>

std::vector<std::string_view> split(std::string_view text, char delimiter) {
    std::vector<std::string_view> parts;
    std::size_t start = 0;
    while (start <= text.size()) {
        const std::size_t end = text.find(delimiter, start);
        const std::size_t length = end == std::string_view::npos ? text.size() - start : end - start;
        parts.push_back(text.substr(start, length));
        if (end == std::string_view::npos) break;
        start = end + 1;
    }
    return parts;
}

int main() {
    const std::string input = "${input}";
    for (const std::string_view part : split(input, ':')) {
        std::cout << '[' << part << ']';
    }
    std::cout << "\\n";
    return 0;
}
`;
    },
  },
  {
    id: "lower-bound",
    structure: "sorted-vector",
    operation: "search",
    algorithm: "lower-bound",
    instruction:
      "Use std::lower_bound para encontrar o primeiro elemento maior ou igual ao alvo e reporte o índice.",
    explanation:
      "A distância entre o iterador retornado e begin() fornece o índice de inserção em tempo logarítmico.",
    tags: ["binary-search", "lower_bound", "stl"],
    difficulty: "intermediate",
    render: (c) => {
      const data = [...c.values].sort((a, b) => a - b).join(", ");
      return `#include <algorithm>
#include <iostream>
#include <vector>

int main() {
    std::vector<int> values{ ${data} };
    std::sort(values.begin(), values.end());

    const int target = ${c.n};
    const auto position = std::lower_bound(values.begin(), values.end(), target);
    const auto index = std::distance(values.begin(), position);

    std::cout << "index=" << index;
    if (position != values.end()) {
        std::cout << " value=" << *position;
    }
    std::cout << '\\n';
    return 0;
}
`;
    },
  },
  {
    id: "variant-visitor",
    structure: "variant",
    operation: "describe-value",
    algorithm: "visitor",
    instruction:
      "Modele int ou string com std::variant e descreva o valor com um visitor sobrecarregado.",
    explanation:
      "std::visit garante que o visitor cubra todas as alternativas do variant.",
    tags: ["variant", "visitor", "polymorphism"],
    difficulty: "advanced",
    render: (c) => {
      return `#include <iostream>
#include <string>
#include <variant>

using Value = std::variant<int, std::string>;

struct Describe {
    void operator()(int value) const {
        std::cout << "int:" << value + ${c.n2} << '\\n';
    }

    void operator()(const std::string& value) const {
        std::cout << "string:" << value << '\\n';
    }
};

int main() {
    const Value first = ${c.n};
    const Value second = std::string{"${c.text}"};
    std::visit(Describe{}, first);
    std::visit(Describe{}, second);
    return 0;
}
`;
    },
  },
  {
    id: "async-futures",
    structure: "task-vector",
    operation: "concurrent-accumulate",
    algorithm: "std-async",
    instruction:
      "Dispare tarefas com std::async, colete os futures e some os resultados no thread principal.",
    explanation:
      "Cada future é consumido com get(), que propaga exceções e sincroniza a conclusão da tarefa.",
    tags: ["async", "future", "concurrency"],
    difficulty: "advanced",
    render: (c) => {
      const tasks = (c.n % 5) + 2;
      return `#include <future>
#include <iostream>
#include <vector>

int triangular(int value) {
    long long total = 0;
    for (int i = 1; i <= value; i++) total += i;
    return static_cast<int>(total);
}

int main() {
    std::vector<std::future<int>> futures;
    futures.reserve(${tasks});
    for (int i = 1; i <= ${tasks}; i++) {
        futures.push_back(std::async(std::launch::async, triangular, i));
    }

    long long total = 0;
    for (auto& future : futures) {
        total += future.get();
    }
    std::cout << "total=" << total << " tag=${c.text}" << '\\n';
    return 0;
}
`;
    },
  },
];

export function generate(): CodeSample[] {
  return composeLanguage({
    language: "cpp",
    label: "C++",
    seed: 0x5eed_4004,
    scenarios,
    styles,
    edges: DEFAULT_EDGES,
    params: DEFAULT_PARAMS,
    min: 800,
  });
}
