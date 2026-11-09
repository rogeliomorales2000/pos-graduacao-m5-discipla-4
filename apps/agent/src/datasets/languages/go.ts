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
    structure: "slice",
    operation: "aggregate",
    algorithm: "range-loop",
    instruction:
      "Implemente em Go um resumo de uma lista de inteiros, devolvendo total, quantidade e média.",
    explanation:
      "O laço sobre o slice mantém a alocação mínima e a média evita divisão por zero quando o slice está vazio.",
    difficulty: "basic",
    render: (c) => {
      const name = c.name("Summarize");
      const data = c.values.join(", ");
      return `package main

import "fmt"

type Summary struct {
	Total   int64
	Count   int
	Average float64
}

func ${name}(values []int) Summary {
	var total int64
	for _, value := range values {
		total += int64(value)
	}
	count := len(values)
	average := 0.0
	if count > 0 {
		average = float64(total) / float64(count)
	}
	return Summary{Total: total, Count: count, Average: average}
}

func main() {
	sample := []int{${data}}
	summary := ${name}(sample)
	fmt.Printf("total=%d count=%d average=%.2f\\n", summary.Total, summary.Count, summary.Average)
	fmt.Println(sample)
}
`;
    },
  },
  {
    id: "group-sales",
    structure: "slice-of-structs",
    operation: "group-by-region",
    algorithm: "map-accumulator",
    instruction:
      "Agrupe vendas por região em Go com map, some os valores e devolva os grupos ordenados por total.",
    explanation:
      "O map[string]int64 acumula por chave e slice+sort.Slice produz uma saída determinística.",
    difficulty: "intermediate",
    render: (c) => {
      const name = c.name("GroupByRegion");
      const rows = c.values
        .map(
          (amount, i) =>
            `\t\t{ID: ${i + 1}, Region: "${regions[i % regions.length]}", Amount: ${amount}},`,
        )
        .join("\n");
      return `package main

import (
	"fmt"
	"sort"
)

type Sale struct {
	ID     int
	Region string
	Amount int64
}

type RegionTotal struct {
	Region string
	Total  int64
}

func ${name}(sales []Sale) []RegionTotal {
	totals := make(map[string]int64)
	for _, sale := range sales {
		totals[sale.Region] += sale.Amount
	}

	entries := make([]RegionTotal, 0, len(totals))
	for region, total := range totals {
		entries = append(entries, RegionTotal{Region: region, Total: total})
	}
	sort.Slice(entries, func(left, right int) bool {
		if entries[left].Total == entries[right].Total {
			return entries[left].Region < entries[right].Region
		}
		return entries[left].Total > entries[right].Total
	})
	return entries
}

func main() {
	sales := []Sale{
${rows}
	}
	for _, entry := range ${name}(sales) {
		fmt.Printf("%s=%d\\n", entry.Region, entry.Total)
	}
}
`;
    },
  },
  {
    id: "word-frequency",
    structure: "text",
    operation: "count-occurrences",
    algorithm: "map-and-sort",
    instruction:
      "Conte a frequência de palavras em Go com map, normalizando caixa e removendo pontuação.",
    explanation:
      "strings.Fields separa por espaços e o map incrementa; a ordenação final usa sort.Slice com desempate.",
    difficulty: "intermediate",
    render: (c) => {
      const name = c.name("CountWords");
      return `package main

import (
	"fmt"
	"sort"
	"strings"
	"unicode"
)

type WordCount struct {
	Word  string
	Count int
}

func ${name}(text string) map[string]int {
	counts := make(map[string]int)
	for _, raw := range strings.Fields(text) {
		word := strings.Map(func(ch rune) rune {
			if unicode.IsLetter(ch) || unicode.IsDigit(ch) {
				return unicode.ToLower(ch)
			}
			return -1
		}, raw)
		if word == "" {
			continue
		}
		counts[word]++
	}
	return counts
}

func main() {
	text := "${c.text} ${c.text} code review ${c.text} ${c.params.text}"
	counts := ${name}(text)
	entries := make([]WordCount, 0, len(counts))
	for word, count := range counts {
		entries = append(entries, WordCount{Word: word, Count: count})
	}
	sort.Slice(entries, func(left, right int) bool {
		if entries[left].Count == entries[right].Count {
			return entries[left].Word < entries[right].Word
		}
		return entries[left].Count > entries[right].Count
	})
	for index, entry := range entries {
		if index >= ${c.n2 % 4 + 2} {
			break
		}
		fmt.Printf("%s:%d\\n", entry.Word, entry.Count)
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
      "Implemente busca binária iterativa em Go e valide com sort.Ints e um alvo conhecido.",
    explanation:
      "Os limites low/high reduzem o intervalo pela metade; retornar -1 sinaliza ausência sem panic.",
    difficulty: "basic",
    render: (c) => {
      const name = c.name("BinarySearch");
      const sorted = [...c.values].sort((a, b) => a - b);
      const target = sorted[Math.floor(sorted.length / 2)];
      return `package main

import (
	"fmt"
	"sort"
)

func ${name}(values []int, target int) int {
	low := 0
	high := len(values) - 1
	for low <= high {
		middle := low + (high-low)/2
		switch {
		case values[middle] == target:
			return middle
		case values[middle] < target:
			low = middle + 1
		default:
			high = middle - 1
		}
	}
	return -1
}

func main() {
	values := []int{${sorted.join(", ")}}
	sort.Ints(values)
	index := ${name}(values, ${target})
	fmt.Printf("index=%d values=%v\\n", index, values)
}
`;
    },
  },
  {
    id: "safe-division",
    structure: "fallible-operation",
    operation: "divide",
    algorithm: "error-return",
    instruction:
      "Escreva uma divisão segura em Go que retorna error para divisor zero e para resultado fora do limite.",
    explanation:
      "Em Go o erro é um valor de retorno explícito; errors.New mantém a mensagem e o chamador decide o fallback.",
    difficulty: "intermediate",
    render: (c) => {
      const name = c.name("Divide");
      const numerator = Math.abs(c.values[0]) + c.n;
      return `package main

import (
	"errors"
	"fmt"
)

var (
	ErrDivideByZero = errors.New("divisor must not be zero")
	ErrOutOfRange   = errors.New("result out of range")
)

func ${name}(numerator, denominator int) (int, error) {
	if denominator == 0 {
		return 0, ErrDivideByZero
	}
	result := numerator / denominator
	if result > ${Math.abs(c.values[0]) + 1000} || result < -${Math.abs(c.values[0]) + 1000} {
		return 0, fmt.Errorf("%w: %d", ErrOutOfRange, result)
	}
	return result, nil
}

func main() {
	value, err := ${name}(${numerator}, ${c.n})
	fmt.Println(value, err)
	_, err = ${name}(${numerator}, 0)
	fmt.Println(errors.Is(err, ErrDivideByZero))
	value, err = ${name}(-${Math.abs(c.values[0]) * 1000 + 7}, 1)
	fmt.Println(value, errors.Is(err, ErrOutOfRange))
}
`;
    },
  },
  {
    id: "worker-pool",
    structure: "concurrency",
    operation: "parallel-transform",
    algorithm: "goroutine-channel",
    instruction:
      "Implemente um pool de workers em Go com goroutines, channel e WaitGroup para transformar uma lista.",
    explanation:
      "O channel transporta trabalho, o WaitGroup sinaliza conclusão e o close permite encerrar o range com segurança.",
    difficulty: "advanced",
    render: (c) => {
      const name = c.name("RunPool");
      const workers = Math.max(2, c.n2 % 4 + 2);
      return `package main

import (
	"fmt"
	"sync"
)

func transform(value int) int {
	return value*2 + ${c.params.a}
}

func ${name}(values []int, workers int) []int {
	jobs := make(chan int, len(values))
	results := make(chan int, len(values))

	var group sync.WaitGroup
	for worker := 0; worker < workers; worker++ {
		group.Add(1)
		go func() {
			defer group.Done()
			for value := range jobs {
				results <- transform(value)
			}
		}()
	}

	go func() {
		defer close(jobs)
		for _, value := range values {
			jobs <- value
		}
	}()

	go func() {
		group.Wait()
		defer close(results)
	}()

	output := make([]int, 0, len(values))
	for value := range results {
		output = append(output, value)
	}
	return output
}

func main() {
	values := []int{${c.values.join(", ")}}
	fmt.Println(${name}(values, ${workers}))
}
`;
    },
  },
  {
    id: "account-struct",
    structure: "struct",
    operation: "apply-transaction",
    algorithm: "methods",
    instruction:
      "Modele uma conta em Go com struct e métodos, validando depósitos e saques sem permitir saldo negativo.",
    explanation:
      "Os métodos usam ponteiro para mutar o estado e retornam error quando a operação viola o contrato.",
    difficulty: "basic",
    render: (c) => {
      const name = c.name("Withdraw");
      return `package main

import (
	"errors"
	"fmt"
)

var ErrInsufficientFunds = errors.New("insufficient funds")

type Account struct {
	Owner   string
	Balance int64
}

func NewAccount(owner string, initial int64) *Account {
	return &Account{Owner: owner, Balance: initial}
}

func (account *Account) Deposit(amount int64) error {
	if amount <= 0 {
		return errors.New("amount must be positive")
	}
	account.Balance += amount
	return nil
}

func (account *Account) ${name}(amount int64) error {
	if amount <= 0 {
		return errors.New("amount must be positive")
	}
	if amount > account.Balance {
		return ErrInsufficientFunds
	}
	account.Balance -= amount
	return nil
}

func main() {
	account := NewAccount("${c.text}", ${Math.abs(c.values[0]) + 100})
	_ = account.Deposit(${c.n * 10})
	fmt.Println(account.${name}(${c.n2 * 5}))
	fmt.Println(account)
	fmt.Println(errors.Is(account.${name}(1_000_000), ErrInsufficientFunds))
}
`;
    },
  },
  {
    id: "shape-interface",
    structure: "interface",
    operation: "compute-area",
    algorithm: "polymorphism",
    instruction:
      "Defina uma interface Shape em Go com círculo e retângulo, e calcule a área total da coleção.",
    explanation:
      "A interface expõe apenas Area e Name, permitindo tratar tipos distintos de forma uniforme.",
    difficulty: "advanced",
    render: (c) => {
      const name = c.name("TotalArea");
      return `package main

import (
	"fmt"
	"math"
)

type Shape interface {
	Area() float64
	Name() string
}

type Circle struct {
	Radius float64
}

func (circle Circle) Area() float64 {
	return math.Pi * circle.Radius * circle.Radius
}

func (circle Circle) Name() string {
	return "circle"
}

type Rectangle struct {
	Width  float64
	Height float64
}

func (rectangle Rectangle) Area() float64 {
	return rectangle.Width * rectangle.Height
}

func (rectangle Rectangle) Name() string {
	return "rectangle"
}

func ${name}(shapes []Shape) float64 {
	total := 0.0
	for _, shape := range shapes {
		total += shape.Area()
	}
	return total
}

func main() {
	shapes := []Shape{
		Circle{Radius: ${(Math.abs(c.values[0]) % 9) + 1}},
		Rectangle{Width: ${c.n}, Height: ${c.n2}},
	}
	for _, shape := range shapes {
		fmt.Printf("%s=%.2f\\n", shape.Name(), shape.Area())
	}
	fmt.Printf("total=%.2f\\n", ${name}(shapes))
}
`;
    },
  },
  {
    id: "defer-cleanup",
    structure: "resource",
    operation: "cleanup",
    algorithm: "defer-recover",
    instruction:
      "Implemente uma função em Go que usa defer e recover para registrar falhas e sempre limpar recursos.",
    explanation:
      "O defer executa mesmo com panic, e recover converte a falha em erro retornado sem derrubar o processo.",
    difficulty: "intermediate",
    render: (c) => {
      const name = c.name("ProcessSafely");
      return `package main

import (
	"errors"
	"fmt"
)

func ${name}(value int) (result int, err error) {
	cleanup := func() {
		fmt.Println("cleanup done")
	}
	defer cleanup()

	defer func() {
		if recovered := recover(); recovered != nil {
			err = fmt.Errorf("recovered: %v", recovered)
			result = -1
		}
	}()

	if value < 0 {
		panic("negative input")
	}
	if value > ${Math.abs(c.values[0]) + 100} {
		return 0, errors.New("value above limit")
	}
	return value * ${c.n}, nil
}

func main() {
	fmt.Println(${name}(${c.n}))
	fmt.Println(${name}(-1))
	fmt.Println(${name}(999999))
}
`;
    },
  },
  {
    id: "generic-max",
    structure: "generic",
    operation: "select-maximum",
    algorithm: "type-constraint",
    instruction:
      "Escreva uma função genérica em Go com constraint própria que devolve o maior item de um slice.",
    explanation:
      "O constraint Ordered agrupa tipos comparáveis; a função retorna o zero value e false para slice vazio.",
    difficulty: "advanced",
    render: (c) => {
      const name = c.name("MaxValue");
      return `package main

import "fmt"

type Ordered interface {
	~int | ~int64 | ~float64 | ~string
}

func ${name}[T Ordered](values []T) (T, bool) {
	var zero T
	if len(values) == 0 {
		return zero, false
	}
	best := values[0]
	for _, value := range values[1:] {
		if value > best {
			best = value
		}
	}
	return best, true
}

func main() {
	numbers := []int{${c.values.join(", ")}}
	words := []string{"${c.text}", "code", "review"}

	number, ok := ${name}(numbers)
	fmt.Println(number, ok)
	word, ok := ${name}(words)
	fmt.Println(word, ok)
	empty, ok := ${name}([]int{})
	fmt.Println(empty, ok)
	fmt.Println(len(numbers))
}
`;
    },
  },
];

export function generate(): CodeSample[] {
  return composeLanguage({
    language: "go",
    label: "Go",
    seed: 0x5eed_100e,
    scenarios,
    styles,
    edges: DEFAULT_EDGES,
    params: DEFAULT_PARAMS,
    min: 800,
  });
}
