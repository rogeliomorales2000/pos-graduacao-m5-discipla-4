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
    algorithm: "linq",
    instruction:
      "Implemente em C# um resumo de uma lista de inteiros com LINQ, devolvendo total, quantidade e média.",
    explanation:
      "Enumerable.Sum/Count evitam laços manuais e o record Summary mantém o resultado imutável.",
    difficulty: "basic",
    render: (c) => {
      const method = c.name("Summarize");
      const data = c.values.join(", ");
      return `using System;
using System.Linq;

namespace Samples;

public static class Demo
{
    public sealed record Summary(long Total, int Count, double Average);

    public static Summary ${method}(int[] values)
    {
        if (values is null) throw new ArgumentNullException(nameof(values));
        var total = values.Sum(value => (long)value);
        var count = values.Length;
        var average = count == 0 ? 0.0 : (double)total / count;
        return new Summary(total, count, average);
    }

    public static void Main()
    {
        var sample = new[] { ${data} };
        var summary = ${method}(sample);
        Console.WriteLine("total=" + summary.Total + " average=" + summary.Average.ToString("F2"));
    }
}
`;
    },
  },
  {
    id: "group-sales",
    structure: "list-of-records",
    operation: "group-by-region",
    algorithm: "linq-groupby",
    instruction:
      "Agrupe vendas por região em C# com GroupBy, some os valores e ordene por total decrescente.",
    explanation:
      "GroupBy preserva a chave e o OrderByDescending garante saída estável por valor agregado.",
    difficulty: "intermediate",
    render: (c) => {
      const method = c.name("GroupByRegion");
      const rows = c.values
        .map((amount, i) => `            new Sale(${i + 1}, "${regions[i % regions.length]}", ${amount}),`)
        .join("\n");
      return `using System;
using System.Collections.Generic;
using System.Linq;

namespace Samples;

public static class Demo
{
    public sealed record Sale(int Id, string Region, long Amount);

    public static IEnumerable<(string Region, long Total)> ${method}(IEnumerable<Sale> sales)
    {
        return sales
            .GroupBy(sale => sale.Region)
            .Select(group => (Region: group.Key, Total: group.Sum(sale => sale.Amount)))
            .OrderByDescending(item => item.Total)
            .ThenBy(item => item.Region);
    }

    public static void Main()
    {
        var sales = new List<Sale>
        {
${rows}
        };

        foreach (var (region, total) in ${method}(sales))
        {
            Console.WriteLine(region + "=" + total);
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
    algorithm: "dictionary",
    instruction:
      "Conte palavras em C# com Dictionary, ignorando caixa e pontuação, e liste as mais frequentes.",
    explanation:
      "TryGetValue evita duas buscas por palavra; a ordenação final usa LINQ sem alterar o dicionário.",
    difficulty: "intermediate",
    render: (c) => {
      const method = c.name("CountWords");
      return `using System;
using System.Collections.Generic;
using System.Linq;

namespace Samples;

public static class Demo
{
    public static Dictionary<string, int> ${method}(string text)
    {
        var counts = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        var cleaned = new string(text.Select(ch => char.IsLetterOrDigit(ch) ? ch : ' ').ToArray());
        foreach (var word in cleaned.Split(' ', StringSplitOptions.RemoveEmptyEntries))
        {
            counts.TryGetValue(word, out var current);
            counts[word] = current + 1;
        }
        return counts;
    }

    public static void Main()
    {
        const string text = "${c.text} ${c.text} code review ${c.text} ${c.params.text}";
        var top = ${method}(text)
            .OrderByDescending(pair => pair.Value)
            .ThenBy(pair => pair.Key)
            .Take(${c.n2 % 4 + 2});

        foreach (var pair in top)
        {
            Console.WriteLine(pair.Key + ":" + pair.Value);
        }
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
      "Implemente busca binária iterativa em C# e valide com Array.Sort e um alvo conhecido.",
    explanation:
      "O cálculo do meio com low + (high - low) / 2 evita overflow e retorna -1 quando ausente.",
    difficulty: "basic",
    render: (c) => {
      const method = c.name("BinarySearch");
      const target = c.values[Math.floor(c.values.length / 2)];
      const data = [...c.values].sort((a, b) => a - b).join(", ");
      return `using System;

namespace Samples;

public static class Demo
{
    public static int ${method}(int[] values, int target)
    {
        if (values is null) throw new ArgumentNullException(nameof(values));
        var low = 0;
        var high = values.Length - 1;
        while (low <= high)
        {
            var middle = low + (high - low) / 2;
            if (values[middle] == target) return middle;
            if (values[middle] < target) low = middle + 1;
            else high = middle - 1;
        }
        return -1;
    }

    public static void Main()
    {
        var values = new[] { ${data} };
        Array.Sort(values);
        Console.WriteLine("index=" + ${method}(values, ${target}));
        Console.WriteLine(string.Join(",", values));
    }
}
`;
    },
  },
  {
    id: "record-validation",
    structure: "record",
    operation: "validate",
    algorithm: "guard-clauses",
    instruction:
      "Modele um usuário como record em C# e valide nome, idade e e-mail com guard clauses.",
    explanation:
      "O construtor do record concentra a validação; ArgumentException identifica exatamente o campo inválido.",
    difficulty: "intermediate",
    render: (c) => {
      const method = c.name("Create");
      return `using System;

namespace Samples;

public static class Demo
{
    public sealed record User(string Name, int Age, string Email)
    {
        public User Validate()
        {
            if (string.IsNullOrWhiteSpace(Name)) throw new ArgumentException("name required");
            if (Age < 0 || Age > 150) throw new ArgumentException("age out of range");
            if (string.IsNullOrWhiteSpace(Email) || !Email.Contains('@')) throw new ArgumentException("invalid email");
            return this;
        }
    }

    public static User ${method}(string name, int age)
    {
        return new User(name, age, name + "@example.com").Validate();
    }

    public static void Main()
    {
        var user = ${method}("${c.text}", ${Math.abs(c.values[0]) % 90});
        Console.WriteLine(user);

        try
        {
            ${method}("", ${c.n});
        }
        catch (ArgumentException error)
        {
            Console.WriteLine("erro=" + error.Message);
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
    algorithm: "task-whenall",
    instruction:
      "Monte um pipeline assíncrono em C# com Task.WhenAll que transforma duas entradas e soma os resultados.",
    explanation:
      "Task.WhenAll preserva a concorrência e o await final garante que exceções sejam observadas.",
    difficulty: "advanced",
    render: (c) => {
      const method = c.name("ComputeAsync");
      return `using System;
using System.Threading.Tasks;

namespace Samples;

public static class Demo
{
    private static async Task<int> TransformAsync(int value)
    {
        await Task.Yield();
        return value * 2 + ${c.params.a};
    }

    public static async Task<int> ${method}(int baseValue)
    {
        var left = TransformAsync(baseValue + ${c.n});
        var right = TransformAsync(baseValue - ${c.n2});
        var results = await Task.WhenAll(left, right);
        return results[0] + results[1];
    }

    public static async Task Main()
    {
        var result = await ${method}(${Math.abs(c.values[0])});
        Console.WriteLine("result=" + result);
    }
}
`;
    },
  },
  {
    id: "concurrent-cache",
    structure: "concurrent-map",
    operation: "cache",
    algorithm: "concurrent-dictionary",
    instruction:
      "Implemente um cache concorrente em C# com ConcurrentDictionary e fábrica de valor idempotente.",
    explanation:
      "GetOrAdd pode executar a fábrica mais de uma vez; para valores caros use Lazy<T> para garantir uma única criação.",
    difficulty: "advanced",
    render: (c) => {
      const method = c.name("GetOrCreate");
      return `using System;
using System.Collections.Concurrent;

namespace Samples;

public static class Demo
{
    private static readonly ConcurrentDictionary<string, Lazy<int>> Cache = new();

    public static int ${method}(string key)
    {
        var lazy = Cache.GetOrAdd(key, name => new Lazy<int>(() => name.Length + ${c.n}));
        return lazy.Value;
    }

    public static void Main()
    {
        Console.WriteLine(${method}("${c.text}"));
        Console.WriteLine(${method}("${c.text}"));
        Console.WriteLine(${method}("${c.params.text}"));
        Console.WriteLine("itens=" + Cache.Count);
    }
}
`;
    },
  },
  {
    id: "domain-exception",
    structure: "exception",
    operation: "guard",
    algorithm: "try-catch-finally",
    instruction:
      "Defina uma exceção de domínio em C# e use try/catch/finally para converter entrada inválida em fallback.",
    explanation:
      "A exceção customizada carrega o valor inválido e o finally garante a limpeza independentemente do caminho.",
    difficulty: "intermediate",
    render: (c) => {
      const method = c.name("ParseQuantity");
      return `using System;

namespace Samples;

public static class Demo
{
    public sealed class DomainException : Exception
    {
        public DomainException(string message) : base(message) { }
    }

    public static int ${method}(string raw)
    {
        if (!int.TryParse(raw, out var value))
        {
            throw new DomainException("quantidade invalida: " + raw);
        }
        if (value <= 0 || value > ${Math.abs(c.values[0]) + 10})
        {
            throw new DomainException("fora do limite: " + value);
        }
        return value;
    }

    public static void Main()
    {
        var inputs = new[] { "${Math.abs(c.values[0])}", "0", "abc" };
        foreach (var input in inputs)
        {
            try
            {
                Console.WriteLine("ok=" + ${method}(input));
            }
            catch (DomainException error)
            {
                Console.WriteLine("fallback=1 (" + error.Message + ")");
            }
            finally
            {
                Console.WriteLine("checked=" + input);
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
    algorithm: "generic-constraint",
    instruction:
      "Escreva um método genérico em C# com restrição IComparable<T> que devolve o maior item de uma coleção.",
    explanation:
      "A restrição where T : IComparable<T> permite CompareTo sem boxing e mantém o tipo concreto.",
    difficulty: "advanced",
    render: (c) => {
      const method = c.name("Max");
      return `using System;
using System.Collections.Generic;
using System.Linq;

namespace Samples;

public static class Demo
{
    public static T ${method}<T>(IReadOnlyList<T> values) where T : IComparable<T>
    {
        if (values.Count == 0) throw new ArgumentException("empty list");
        var best = values[0];
        for (var i = 1; i < values.Count; i++)
        {
            if (values[i].CompareTo(best) > 0) best = values[i];
        }
        return best;
    }

    public static void Main()
    {
        Console.WriteLine("int=" + ${method}(new[] { ${c.values.join(", ")} }));
        Console.WriteLine("str=" + ${method}(new[] { "${c.text}", "code", "review" }));
        Console.WriteLine("double=" + ${method}(new[] { ${c.values[0]}.5, ${c.values[1]}.25 }));
        Console.WriteLine("count=" + new[] { 1, 2, 3 }.Count());
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
      "Modele níveis de severidade como enum em C# e classifique uma pontuação com switch expression.",
    explanation:
      "O switch expression cobre todos os intervalos e o cast explícito mantém o tipo do enum.",
    difficulty: "basic",
    render: (c) => {
      const method = c.name("Classify");
      const score = Math.abs(c.values[0]) % 100;
      return `using System;

namespace Samples;

public static class Demo
{
    public enum Level
    {
        Low = 0,
        Medium = 1,
        High = 2,
        Critical = 3
    }

    public static Level ${method}(int score)
    {
        if (score < 0 || score > 100) throw new ArgumentOutOfRangeException(nameof(score));
        return score switch
        {
            < 40 => Level.Low,
            < 70 => Level.Medium,
            < 90 => Level.High,
            _ => Level.Critical
        };
    }

    public static void Main()
    {
        var score = ${score};
        var level = ${method}(score);
        Console.WriteLine("score=" + score + " level=" + level);
        foreach (var candidate in Enum.GetValues<Level>())
        {
            Console.WriteLine(candidate + "=" + (int)candidate);
        }
    }
}
`;
    },
  },
];

export function generate(): CodeSample[] {
  return composeLanguage({
    language: "cs",
    label: "C#",
    seed: 0x5eed_100c,
    scenarios,
    styles,
    edges: DEFAULT_EDGES,
    params: DEFAULT_PARAMS,
    min: 800,
  });
}
