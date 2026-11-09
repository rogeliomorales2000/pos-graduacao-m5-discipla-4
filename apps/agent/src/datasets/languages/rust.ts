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
    structure: "vec",
    operation: "aggregate",
    algorithm: "iterator-fold",
    instruction:
      "Implemente em Rust um resumo de uma lista de inteiros com iteradores, devolvendo total, quantidade e média.",
    explanation:
      "O fold evita estado mutável compartilhado e a média trata a lista vazia sem divisão por zero.",
    difficulty: "basic",
    render: (c) => {
      const name = c.name("summarize");
      const data = c.values.join(", ");
      return `#[derive(Debug, Clone, PartialEq)]
struct Summary {
    total: i64,
    count: usize,
    average: f64,
}

fn ${name}(values: &[i64]) -> Summary {
    let total = values.iter().copied().fold(0i64, |acc, value| acc + value);
    let count = values.len();
    let average = if count == 0 {
        0.0
    } else {
        total as f64 / count as f64
    };
    Summary { total, count, average }
}

fn main() {
    let sample: Vec<i64> = vec![${data}];
    let summary = ${name}(&sample);
    println!("total={} count={} average={:.2}", summary.total, summary.count, summary.average);
    println!("{sample:?}");
}
`;
    },
  },
  {
    id: "group-sales",
    structure: "vec-of-structs",
    operation: "group-by-region",
    algorithm: "hash-map",
    instruction:
      "Agrupe vendas por região em Rust com HashMap, some os valores e ordene por total decrescente.",
    explanation:
      "A entrada do mapa acumula com *entry.or_insert(0) e a ordenação usa sort_by com comparação explícita.",
    difficulty: "intermediate",
    render: (c) => {
      const name = c.name("group_by_region");
      const rows = c.values
        .map(
          (amount, i) =>
            `        Sale { id: ${i + 1}, region: "${regions[i % regions.length]}", amount: ${amount} },`,
        )
        .join("\n");
      return `use std::collections::HashMap;

#[derive(Debug, Clone)]
struct Sale {
    id: u32,
    region: &'static str,
    amount: i64,
}

fn ${name}(sales: &[Sale]) -> Vec<(String, i64)> {
    let mut totals: HashMap<&str, i64> = HashMap::new();
    for sale in sales {
        *totals.entry(sale.region).or_insert(0) += sale.amount;
    }

    let mut entries: Vec<(String, i64)> = totals
        .into_iter()
        .map(|(region, total)| (region.to_string(), total))
        .collect();
    entries.sort_by(|left, right| right.1.cmp(&left.1).then_with(|| left.0.cmp(&right.0)));
    entries
}

fn main() {
    let sales = vec![
${rows}
    ];
    for (region, total) in ${name}(&sales) {
        println!("{region}={total}");
    }
}
`;
    },
  },
  {
    id: "word-frequency",
    structure: "text",
    operation: "count-occurrences",
    algorithm: "hash-map-entry",
    instruction:
      "Conte frequências de palavras em Rust com HashMap, normalizando caixa e removendo pontuação.",
    explanation:
      "A normalização usa map e collect; a API entry evita buscas duplicadas ao incrementar.",
    difficulty: "intermediate",
    render: (c) => {
      const name = c.name("count_words");
      return `use std::collections::HashMap;

fn ${name}(text: &str) -> HashMap<String, usize> {
    let mut counts: HashMap<String, usize> = HashMap::new();
    for word in text.split_whitespace() {
        let normalized: String = word
            .chars()
            .filter(|ch| ch.is_alphanumeric())
            .flat_map(|ch| ch.to_lowercase())
            .collect();
        if normalized.is_empty() {
            continue;
        }
        *counts.entry(normalized).or_insert(0) += 1;
    }
    counts
}

fn main() {
    let text = "${c.text} ${c.text} code review ${c.text} ${c.params.text}";
    let counts = ${name}(text);
    let mut pairs: Vec<(&String, &usize)> = counts.iter().collect();
    pairs.sort_by(|left, right| right.1.cmp(left.1).then_with(|| left.0.cmp(right.0)));
    for (word, count) in pairs.iter().take(${c.n2 % 4 + 2}) {
        println!("{word}:{count}");
    }
}
`;
    },
  },
  {
    id: "binary-search",
    structure: "sorted-slice",
    operation: "search",
    algorithm: "binary-search",
    instruction:
      "Implemente busca binária iterativa em Rust e valide com uma lista ordenada e um alvo conhecido.",
    explanation:
      "Os índices low/high delimitam o intervalo restante e o retorno Option expressa ausência sem sentinela.",
    difficulty: "basic",
    render: (c) => {
      const name = c.name("binary_search");
      const sorted = [...c.values].sort((a, b) => a - b);
      const target = sorted[Math.floor(sorted.length / 2)];
      return `fn ${name}(values: &[i64], target: i64) -> Option<usize> {
    let mut low = 0usize;
    let mut high = values.len();

    while low < high {
        let middle = low + (high - low) / 2;
        if values[middle] == target {
            return Some(middle);
        }
        if values[middle] < target {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    None
}

fn main() {
    let mut values: Vec<i64> = vec![${sorted.join(", ")}];
    values.sort();
    match ${name}(&values, ${target}) {
        Some(index) => println!("found at {index}"),
        None => println!("not found"),
    }
    println!("{values:?}");
}
`;
    },
  },
  {
    id: "safe-division",
    structure: "fallible-operation",
    operation: "divide",
    algorithm: "result-question-mark",
    instruction:
      "Escreva uma divisão segura em Rust que usa Result e o operador ? para propagar erros de domínio.",
    explanation:
      "O operador ? converte o erro no tipo de retorno e mantém o fluxo principal livre de match aninhado.",
    difficulty: "intermediate",
    render: (c) => {
      const name = c.name("divide");
      const numerator = Math.abs(c.values[0]) + c.n;
      return `#[derive(Debug, PartialEq)]
enum MathError {
    DivideByZero,
    OutOfRange,
}

fn ${name}(numerator: i64, denominator: i64) -> Result<i64, MathError> {
    if denominator == 0 {
        return Err(MathError::DivideByZero);
    }
    let result = numerator.checked_div(denominator).ok_or(MathError::OutOfRange)?;
    if result.abs() > ${Math.abs(c.values[0]) + 1000} {
        return Err(MathError::OutOfRange);
    }
    Ok(result)
}

fn main() {
    println!("{:?}", ${name}(${numerator}, ${c.n}));
    println!("{:?}", ${name}(${numerator}, 0));
    println!("{:?}", ${name}(-${numerator}, ${c.n2}));
}
`;
    },
  },
  {
    id: "shape-trait",
    structure: "trait",
    operation: "compute-area",
    algorithm: "dynamic-dispatch",
    instruction:
      "Defina uma trait Shape em Rust com implementações para círculo e retângulo, e calcule a área total.",
    explanation:
      "A trait define o contrato e o Box<dyn Shape> permite heterogeneidade sem enum manual.",
    difficulty: "advanced",
    render: (c) => {
      const name = c.name("total_area");
      return `trait Shape {
    fn area(&self) -> f64;
    fn label(&self) -> &'static str;
}

struct Circle {
    radius: f64,
}

struct Rectangle {
    width: f64,
    height: f64,
}

impl Shape for Circle {
    fn area(&self) -> f64 {
        std::f64::consts::PI * self.radius * self.radius
    }

    fn label(&self) -> &'static str {
        "circle"
    }
}

impl Shape for Rectangle {
    fn area(&self) -> f64 {
        self.width * self.height
    }

    fn label(&self) -> &'static str {
        "rectangle"
    }
}

fn ${name}(shapes: &[Box<dyn Shape>]) -> f64 {
    shapes.iter().map(|shape| shape.area()).sum()
}

fn main() {
    let shapes: Vec<Box<dyn Shape>> = vec![
        Box::new(Circle { radius: ${(Math.abs(c.values[0]) % 9) + 1}.0 }),
        Box::new(Rectangle { width: ${c.n}.0, height: ${c.n2}.0 }),
    ];
    for shape in &shapes {
        println!("{}={:.2}", shape.label(), shape.area());
    }
    println!("total={:.2}", ${name}(&shapes));
}
`;
    },
  },
  {
    id: "generic-max",
    structure: "generic",
    operation: "select-maximum",
    algorithm: "trait-bound",
    instruction:
      "Escreva uma função genérica em Rust com trait bound PartialOrd que devolve referência ao maior item.",
    explanation:
      "O bound PartialOrd permite comparar sem conhecer o tipo concreto e o retorno Option cobre coleção vazia.",
    difficulty: "advanced",
    render: (c) => {
      const name = c.name("max_value");
      return `fn ${name}<T: PartialOrd + Copy>(values: &[T]) -> Option<T> {
    let mut best = *values.first()?;
    for value in values.iter().skip(1) {
        if *value > best {
            best = *value;
        }
    }
    Some(best)
}

fn main() {
    let numbers: Vec<i64> = vec![${c.values.join(", ")}];
    let words = vec!["${c.text}", "code", "review"];

    println!("number={:?}", ${name}(&numbers));
    println!("word={:?}", ${name}(&words));
    println!("empty={:?}", ${name}::<i64>(&[]));
}
`;
    },
  },
  {
    id: "undo-stack",
    structure: "stack",
    operation: "undo-history",
    algorithm: "vec-as-stack",
    instruction:
      "Crie um histórico de undo em Rust usando Vec como pilha, com limite de tamanho e retorno Option.",
    explanation:
      "push/pop sobre Vec são O(1) amortizado; ao exceder o limite removemos o primeiro elemento.",
    difficulty: "basic",
    render: (c) => {
      const name = c.name("apply");
      const limit = Math.max(2, c.n2 % 5 + 2);
      return `#[derive(Debug)]
struct History {
    entries: Vec<String>,
    limit: usize,
}

impl History {
    fn new(limit: usize) -> Self {
        History {
            entries: Vec::new(),
            limit,
        }
    }

    fn ${name}(&mut self, action: &str) {
        if self.entries.len() == self.limit {
            self.entries.remove(0);
        }
        self.entries.push(action.to_string());
    }

    fn undo(&mut self) -> Option<String> {
        self.entries.pop()
    }
}

fn main() {
    let mut history = History::new(${limit});
    for index in 0..${c.count + 2} {
        history.${name}(&format!("action-{index}"));
    }
    println!("undo={:?}", history.undo());
    println!("remaining={}", history.entries.len());
}
`;
    },
  },
  {
    id: "score-struct",
    structure: "struct",
    operation: "update-score",
    algorithm: "methods",
    instruction:
      "Modele uma pontuação em Rust com struct e métodos, aplicando bônus e limitando o valor máximo.",
    explanation:
      "Os métodos consomem &mut self para deixar a mutação explícita, e clamp garante o intervalo válido.",
    difficulty: "basic",
    render: (c) => {
      const name = c.name("add_bonus");
      const maximum = Math.abs(c.values[0]) + 50;
      return `#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Score {
    value: i64,
    maximum: i64,
}

impl Score {
    fn new(value: i64, maximum: i64) -> Self {
        Score {
            value: value.clamp(0, maximum),
            maximum,
        }
    }

    fn ${name}(&mut self, bonus: i64) {
        self.value = (self.value + bonus).clamp(0, self.maximum);
    }

    fn is_maximum(&self) -> bool {
        self.value == self.maximum
    }
}

fn main() {
    let mut score = Score::new(${Math.abs(c.values[0]) % 40}, ${maximum});
    score.${name}(${c.n});
    score.${name}(${c.n2 * 3});
    println!("{score:?} maximum={}", score.is_maximum());
}
`;
    },
  },
  {
    id: "test-suite",
    structure: "tests",
    operation: "verify",
    algorithm: "test-attributes",
    instruction:
      "Escreva testes unitários em Rust com #[test] para uma função de soma segura, cobrindo sucesso e overflow.",
    explanation:
      "Os testes ficam no módulo tests com cfg(test); checked_add permite verificar overflow sem panic.",
    difficulty: "intermediate",
    render: (c) => {
      const name = c.name("safe_add");
      return `fn ${name}(left: i64, right: i64) -> Option<i64> {
    left.checked_add(right)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adds_regular_values() {
        assert_eq!(${name}(${c.n}, ${c.n2}), Some(${c.n + c.n2}));
        assert_eq!(${name}(-${c.n}, ${c.n2}), Some(${c.n2 - c.n}));
    }

    #[test]
    fn rejects_overflow() {
        assert_eq!(${name}(i64::MAX, 1), None);
        assert_eq!(${name}(i64::MIN, -1), None);
    }

    #[test]
    fn handles_zero() {
        assert_eq!(${name}(0, ${c.n}), Some(${c.n}));
    }
}

fn main() {
    println!("{:?}", ${name}(${c.n}, ${c.n2}));
    println!("total_checks=3");
}
`;
    },
  },
];

export function generate(): CodeSample[] {
  return composeLanguage({
    language: "rust",
    label: "Rust",
    seed: 0x5eed_100d,
    scenarios,
    styles,
    edges: DEFAULT_EDGES,
    params: DEFAULT_PARAMS,
    min: 800,
  });
}
