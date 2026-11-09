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
    structure: "int-array",
    operation: "aggregate",
    algorithm: "stream",
    instruction:
      "Implemente em Java um resumo de uma lista de inteiros usando Stream, devolvendo total, quantidade e média.",
    explanation:
      "IntStream evita boxing; o record Summary mantém o resultado imutável e a média trata lista vazia.",
    difficulty: "basic",
    render: (c) => {
      const method = c.name("summarize");
      const data = c.values.join(", ");
      return `import java.util.Arrays;
import java.util.stream.IntStream;

public final class Demo {
    public record Summary(long total, int count, double average) {}

    static Summary ${method}(int[] values) {
        long total = IntStream.of(values).asLongStream().sum();
        int count = values.length;
        double average = count == 0 ? 0.0 : (double) total / count;
        return new Summary(total, count, average);
    }

    public static void main(String[] args) {
        int[] sample = {${data}};
        Summary summary = ${method}(sample);
        System.out.printf("total=%d average=%.2f%n", summary.total(), summary.average());
        System.out.println(Arrays.toString(sample));
    }
}
`;
    },
  },
  {
    id: "group-sales",
    structure: "list-of-records",
    operation: "group-by-region",
    algorithm: "hash-map",
    instruction:
      "Agrupe vendas por região em Java, somando os valores e devolvendo as entradas ordenadas por total decrescente.",
    explanation:
      "O HashMap acumula por chave e o Stream sobre entrySet ordena sem mutar o mapa original.",
    difficulty: "intermediate",
    render: (c) => {
      const method = c.name("groupByRegion");
      const rows = c.values
        .map((amount, i) => `        new Sale(${i + 1}, "${regions[i % regions.length]}", ${amount})`)
        .join(",\n");
      return `import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

public final class Demo {
    public record Sale(int id, String region, long amount) {}

    static List<Map.Entry<String, Long>> ${method}(List<Sale> sales) {
        Map<String, Long> totals = new HashMap<>();
        for (Sale sale : sales) {
            totals.merge(sale.region(), sale.amount(), Long::sum);
        }
        List<Map.Entry<String, Long>> entries = new ArrayList<>(totals.entrySet());
        entries.sort(Map.Entry.<String, Long>comparingByValue(Comparator.reverseOrder()));
        return entries;
    }

    public static void main(String[] args) {
        List<Sale> sales = List.of(
${rows}
        );
        for (Map.Entry<String, Long> entry : ${method}(sales)) {
            System.out.printf("%s=%d%n", entry.getKey(), entry.getValue());
        }
    }
}
`;
    },
  },
  {
    id: "word-frequency",
    structure: "text",
    operation: "count-occurrences",
    algorithm: "split-and-map",
    instruction:
      "Conte a frequência de palavras em um texto Java, ignorando caixa e pontuação, e mostre as mais frequentes.",
    explanation:
      "A normalização com toLowerCase e replaceAll deixa apenas letras; o merge incrementa o contador.",
    difficulty: "intermediate",
    render: (c) => {
      const method = c.name("countWords");
      return `import java.util.LinkedHashMap;
import java.util.Map;

public final class Demo {
    static Map<String, Integer> ${method}(String text) {
        Map<String, Integer> counts = new LinkedHashMap<>();
        String normalized = text.toLowerCase().replaceAll("[^a-z0-9 ]", " ");
        for (String word : normalized.trim().split("\\\\s+")) {
            if (word.isEmpty()) continue;
            counts.merge(word, 1, Integer::sum);
        }
        return counts;
    }

    public static void main(String[] args) {
        String text = "${c.text} ${c.text} code review ${c.text} ${c.params.text}";
        ${method}(text).entrySet().stream()
            .filter(e -> e.getValue() >= ${c.n2 % 3 + 1})
            .forEach(e -> System.out.printf("%s:%d%n", e.getKey(), e.getValue()));
    }
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
      "Implemente busca binária iterativa em Java e valide o resultado com uma lista ordenada.",
    explanation:
      "Os limites low/high reduzem o intervalo pela metade; retornar -1 sinaliza ausência sem exceção.",
    difficulty: "basic",
    render: (c) => {
      const method = c.name("binarySearch");
      const target = c.values[Math.floor(c.values.length / 2)];
      const data = [...c.values].sort((a, b) => a - b).join(", ");
      return `import java.util.Arrays;

public final class Demo {
    static int ${method}(int[] values, int target) {
        int low = 0;
        int high = values.length - 1;
        while (low <= high) {
            int middle = low + (high - low) / 2;
            if (values[middle] == target) return middle;
            if (values[middle] < target) low = middle + 1;
            else high = middle - 1;
        }
        return -1;
    }

    public static void main(String[] args) {
        int[] values = {${data}};
        Arrays.sort(values);
        int index = ${method}(values, ${target});
        System.out.println("index=" + index);
    }
}
`;
    },
  },
  {
    id: "undo-stack",
    structure: "stack",
    operation: "undo-history",
    algorithm: "deque",
    instruction:
      "Crie um histórico de undo em Java usando ArrayDeque, com push, pop e limite de tamanho.",
    explanation:
      "ArrayDeque é mais eficiente que Stack sincronizado; o limite remove o mais antigo com removeLast.",
    difficulty: "basic",
    render: (c) => {
      const method = c.name("apply");
      const limit = Math.max(2, c.n2 % 5 + 2);
      return `import java.util.ArrayDeque;
import java.util.Deque;

public final class Demo {
    private final Deque<String> history = new ArrayDeque<>();
    private final int limit = ${limit};

    void ${method}(String action) {
        history.push(action);
        while (history.size() > limit) {
            history.removeLast();
        }
    }

    String undo() {
        return history.isEmpty() ? "<vazio>" : history.pop();
    }

    public static void main(String[] args) {
        Demo demo = new Demo();
        for (int i = 0; i < ${c.count + 2}; i++) {
            demo.${method}("action-" + i);
        }
        System.out.println("undo=" + demo.undo());
        System.out.println("restantes=" + demo.history.size());
    }
}
`;
    },
  },
  {
    id: "record-validation",
    structure: "record",
    operation: "validate",
    algorithm: "compact-constructor",
    instruction:
      "Modele um usuário com record em Java e valide os campos no construtor compacto, lançando exceção específica.",
    explanation:
      "O construtor compacto do record centraliza a validação e mantém a imutabilidade do objeto.",
    difficulty: "intermediate",
    render: (c) => {
      const method = c.name("create");
      return `public final class Demo {
    public record User(String name, int age, String email) {
        public User {
            if (name == null || name.isBlank()) {
                throw new IllegalArgumentException("name required");
            }
            if (age < 0 || age > 150) {
                throw new IllegalArgumentException("age out of range: " + age);
            }
            if (email == null || !email.contains("@")) {
                throw new IllegalArgumentException("invalid email");
            }
        }
    }

    static User ${method}(String name, int age) {
        return new User(name, age, name + "@example.com");
    }

    public static void main(String[] args) {
        User user = ${method}("${c.text}", ${Math.abs(c.values[0]) % 90});
        System.out.println(user);
        try {
            ${method}("", ${c.n});
        } catch (IllegalArgumentException error) {
            System.out.println("erro=" + error.getMessage());
        }
    }
}
`;
    },
  },
  {
    id: "async-pipeline",
    structure: "async",
    operation: "transform",
    algorithm: "completable-future",
    instruction:
      "Monte um pipeline assíncrono em Java com CompletableFuture que busca, transforma e combina dois valores.",
    explanation:
      "thenApply encadeia transformações e thenCombine junta resultados independentes sem bloquear a thread principal.",
    difficulty: "advanced",
    render: (c) => {
      const method = c.name("compute");
      return `import java.util.concurrent.CompletableFuture;

public final class Demo {
    static int doubleValue(int value) {
        return value * 2;
    }

    static CompletableFuture<Integer> ${method}(int base) {
        CompletableFuture<Integer> left = CompletableFuture
            .supplyAsync(() -> base + ${c.n})
            .thenApply(Demo::doubleValue);
        CompletableFuture<Integer> right = CompletableFuture
            .supplyAsync(() -> base - ${c.n2})
            .thenApply(value -> value + ${c.params.a});
        return left.thenCombine(right, Integer::sum);
    }

    public static void main(String[] args) throws Exception {
        int result = ${method}(${Math.abs(c.values[0])}).join();
        System.out.println("result=" + result);
    }
}
`;
    },
  },
  {
    id: "domain-exception",
    structure: "exception",
    operation: "guard",
    algorithm: "try-catch",
    instruction:
      "Defina uma exceção de domínio em Java e use try/catch para converter entrada inválida em resposta segura.",
    explanation:
      "A exceção unchecked carrega contexto, e o catch devolve um fallback sem esconder a causa.",
    difficulty: "intermediate",
    render: (c) => {
      const method = c.name("parseQuantity");
      return `public final class Demo {
    static final class DomainException extends RuntimeException {
        DomainException(String message) {
            super(message);
        }
    }

    static int ${method}(String raw) {
        int value;
        try {
            value = Integer.parseInt(raw);
        } catch (NumberFormatException error) {
            throw new DomainException("quantidade inválida: " + raw);
        }
        if (value <= 0 || value > ${Math.abs(c.values[0]) + 10}) {
            throw new DomainException("fora do limite: " + value);
        }
        return value;
    }

    public static void main(String[] args) {
        String[] inputs = {"${Math.abs(c.values[0])}", "0", "abc"};
        for (String input : inputs) {
            try {
                System.out.println("ok=" + ${method}(input));
            } catch (DomainException error) {
                System.out.println("fallback=1 (" + error.getMessage() + ")");
            }
        }
    }
}
`;
    },
  },
  {
    id: "generic-max",
    structure: "generic",
    operation: "select-maximum",
    algorithm: "bounded-generics",
    instruction:
      "Escreva um método genérico em Java que devolve o máximo de uma coleção com limite Comparable.",
    explanation:
      "O bound <T extends Comparable<T>> permite comparar sem cast e preserva o tipo do chamador.",
    difficulty: "advanced",
    render: (c) => {
      const method = c.name("max");
      return `import java.util.List;

public final class Demo {
    static <T extends Comparable<T>> T ${method}(List<T> values) {
        if (values.isEmpty()) {
            throw new IllegalArgumentException("empty list");
        }
        T best = values.get(0);
        for (T value : values) {
            if (value.compareTo(best) > 0) {
                best = value;
            }
        }
        return best;
    }

    public static void main(String[] args) {
        System.out.println("int=" + ${method}(List.of(${c.values.join(", ")})));
        System.out.println("str=" + ${method}(List.of("${c.text}", "code", "review")));
        System.out.println("double=" + ${method}(List.of(${c.values[0]}.5, ${c.values[1]}.25)));
    }
}
`;
    },
  },
  {
    id: "level-enum",
    structure: "enum",
    operation: "classify",
    algorithm: "switch-expression",
    instruction:
      "Modele níveis de severidade como enum em Java e classifique uma pontuação com switch expression.",
    explanation:
      "Cada constante carrega o limite mínimo; o switch expression mantém a classificação exaustiva e legível.",
    difficulty: "basic",
    render: (c) => {
      const method = c.name("classify");
      const score = Math.abs(c.values[0]) % 100;
      return `public final class Demo {
    enum Level {
        LOW(0), MEDIUM(40), HIGH(70), CRITICAL(90);

        final int minimum;

        Level(int minimum) {
            this.minimum = minimum;
        }
    }

    static Level ${method}(int score) {
        if (score < 0 || score > 100) {
            throw new IllegalArgumentException("score out of range");
        }
        return switch (score / 10) {
            case 0, 1, 2, 3 -> Level.LOW;
            case 4, 5, 6 -> Level.MEDIUM;
            case 7, 8 -> Level.HIGH;
            default -> Level.CRITICAL;
        };
    }

    public static void main(String[] args) {
        int score = ${score};
        Level level = ${method}(score);
        System.out.printf("score=%d level=%s%n", score, level);
        for (Level candidate : Level.values()) {
            System.out.printf("%s>=%d%n", candidate, candidate.minimum);
        }
    }
}
`;
    },
  },
];

export function generate(): CodeSample[] {
  return composeLanguage({
    language: "java",
    label: "Java",
    seed: 0x5eed_100b,
    scenarios,
    styles,
    edges: DEFAULT_EDGES,
    params: DEFAULT_PARAMS,
    min: 800,
  });
}
