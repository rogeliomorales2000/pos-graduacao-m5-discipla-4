import type { CodeSample } from "../types.ts";
import {
  DEFAULT_EDGES,
  DEFAULT_PARAMS,
  composeLanguage,
  stylesFor,
  type Scenario,
} from "./_engine.ts";

const baseStyles = stylesFor("//");
const styles = baseStyles.map((style) => ({
  ...style,
  header: (title: string) => `<?php\n${style.header(title)}`,
}));

const scenarios: Scenario[] = [
  {
    id: "pdo-query",
    structure: "database-table",
    operation: "prepared-select",
    algorithm: "pdo",
    instruction:
      "Consulte usuários com PDO e prepared statement, vinculando o limite como inteiro e retornando arrays.",
    explanation:
      "O bindValue com PDO::PARAM_INT impede que o limite seja tratado como texto; o modo de erro lança exceções.",
    tags: ["pdo", "sql", "prepared-statement"],
    difficulty: "intermediate",
    render: (c) => {
      const limit = (c.n % 5) + 1;
      return `declare(strict_types=1);

function fetchUsers(PDO $pdo, int $limit): array
{
    $stmt = $pdo->prepare(
        'SELECT id, name, score FROM users ORDER BY score DESC LIMIT :limit'
    );
    $stmt->bindValue(':limit', $limit, PDO::PARAM_INT);
    $stmt->execute();
    return $stmt->fetchAll(PDO::FETCH_ASSOC);
}

$pdo = new PDO('sqlite::memory:');
$pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
$pdo->exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, score INTEGER)');
$pdo->exec("INSERT INTO users (name, score) VALUES ('${c.text}', ${c.n})");

print_r(fetchUsers($pdo, ${limit}));
`;
    },
  },
  {
    id: "array-pipeline",
    structure: "numeric-array",
    operation: "filter-map-reduce",
    algorithm: "array-functions",
    instruction:
      "Filtre valores positivos, aplique uma escala e reduza a soma usando funções de array do PHP.",
    explanation:
      "array_filter preserva as chaves, por isso array_values normaliza a lista antes do map.",
    tags: ["arrays", "array-filter", "array-reduce"],
    difficulty: "basic",
    render: (c) => {
      const data = c.values.join(", ");
      return `declare(strict_types=1);

$values = [${data}];
$factor = ${Math.max(2, c.n % 9)};

$positive = array_values(array_filter(
    $values,
    static fn (int $value): bool => $value > 0
));
$scaled = array_map(
    static fn (int $value): int => $value * $factor,
    $positive
);
$total = array_reduce(
    $scaled,
    static fn (int $carry, int $value): int => $carry + $value,
    0
);

printf("count=%d total=%d tag=%s\\n", count($scaled), $total, '${c.text}');
`;
    },
  },
  {
    id: "validator-class",
    structure: "input-array",
    operation: "validate",
    algorithm: "class-invariants",
    instruction:
      "Implemente uma classe final de validação que normaliza e-mail, limita score e devolve erros.",
    explanation:
      "A classe acumula mensagens em vez de lançar no primeiro erro, permitindo exibir todos os problemas de uma vez.",
    tags: ["validation", "class", "email"],
    difficulty: "intermediate",
    render: (c) => {
      const cls = c.name("UserValidator");
      return `declare(strict_types=1);

final class ${cls}
{
    public function validate(array $input): array
    {
        $errors = [];
        $email = strtolower(trim((string) ($input['email'] ?? '')));
        $score = filter_var($input['score'] ?? null, FILTER_VALIDATE_INT);

        if (filter_var($email, FILTER_VALIDATE_EMAIL) === false) {
            $errors[] = 'invalid email';
        }
        if ($score === false || $score < 0 || $score > 100) {
            $errors[] = 'score must be between 0 and 100';
        }

        return [
            'ok' => $errors === [],
            'email' => $email,
            'score' => $score === false ? 0 : $score,
            'errors' => $errors,
        ];
    }
}

$validator = new ${cls}();
print_r($validator->validate(['email' => '${c.text}@example.com', 'score' => ${c.n % 101}]));
`;
    },
  },
  {
    id: "json-response",
    structure: "http-payload",
    operation: "json-response",
    algorithm: "json-encode",
    instruction:
      "Monte uma resposta JSON com status HTTP, cabeçalho de conteúdo e tratamento de falha de codificação.",
    explanation:
      "JSON_THROW_ON_ERROR transforma erros de codificação em exceções e o exit impede saída adicional.",
    tags: ["json", "http", "api"],
    difficulty: "intermediate",
    render: (c) => {
      return `declare(strict_types=1);

function respond(array $payload, int $status = 200): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');

    try {
        echo json_encode($payload, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE);
    } catch (JsonException $error) {
        http_response_code(500);
        echo json_encode(['error' => $error->getMessage()]);
    }
}

respond([
    'ok' => true,
    'name' => '${c.text}',
    'limit' => ${c.n},
    'items' => [${c.values.slice(0, 4).join(", ")}],
]);
`;
    },
  },
  {
    id: "file-generator",
    structure: "text-file",
    operation: "stream-lines",
    algorithm: "generator-finally",
    instruction:
      "Leia um arquivo linha a linha com generator e garanta fclose no bloco finally.",
    explanation:
      "O generator entrega cada linha sob demanda e o finally fecha o handle mesmo se o consumidor parar antes.",
    tags: ["generator", "files", "finally"],
    difficulty: "intermediate",
    render: (c) => {
      return `declare(strict_types=1);

function readLines(string $path): Generator
{
    $handle = fopen($path, 'rb');
    if ($handle === false) {
        throw new RuntimeException("cannot open $path");
    }

    try {
        while (($line = fgets($handle)) !== false) {
            yield trim($line);
        }
    } finally {
        fclose($handle);
    }
}

$path = sys_get_temp_dir() . DIRECTORY_SEPARATOR . '${c.text}.log';
file_put_contents($path, "alpha\\nbeta\\n${c.n}\\n");
foreach (readLines($path) as $index => $line) {
    printf("%d:%s\\n", $index, $line);
}
unlink($path);
`;
    },
  },
  {
    id: "password-hash",
    structure: "credentials",
    operation: "hash-and-verify",
    algorithm: "password-api",
    instruction:
      "Gere hash de senha com password_hash, verifique com password_verify e reporte se precisa rehash.",
    explanation:
      "O algoritmo padrão pode mudar entre versões do PHP; password_needs_rehash sinaliza quando atualizar.",
    tags: ["security", "password", "hash"],
    difficulty: "intermediate",
    render: (c) => {
      return `declare(strict_types=1);

$password = '${c.text}-secret-${c.n}';
$hash = password_hash($password, PASSWORD_DEFAULT, ['cost' => 10]);

if ($hash === false) {
    throw new RuntimeException('password hashing failed');
}

$valid = password_verify($password, $hash);
$wrong = password_verify($password . '-wrong', $hash);
$needsRehash = password_needs_rehash($hash, PASSWORD_DEFAULT);

printf(
    "valid=%s wrong=%s rehash=%s length=%d\\n",
    $valid ? 'yes' : 'no',
    $wrong ? 'yes' : 'no',
    $needsRehash ? 'yes' : 'no',
    strlen($hash)
);
`;
    },
  },
  {
    id: "usort-records",
    structure: "record-array",
    operation: "sort-descending",
    algorithm: "usort-spaceship",
    instruction:
      "Ordene registros por score decrescente e desempate por nome usando usort e o operador spaceship.",
    explanation:
      "O comparador devolve inteiro negativo, zero ou positivo; o desempate com strcmp mantém a ordem estável.",
    tags: ["usort", "records", "spaceship"],
    difficulty: "basic",
    render: (c) => {
      const rows = c.values
        .slice(0, 5)
        .map((score, i) => `    ['name' => 'user${i + 1}', 'score' => ${score}],`)
        .join("\n");
      return `declare(strict_types=1);

$records = [
${rows}
];

usort($records, static function (array $left, array $right): int {
    $byScore = $right['score'] <=> $left['score'];
    return $byScore !== 0 ? $byScore : strcmp($left['name'], $right['name']);
});

foreach (array_slice($records, 0, ${(c.n % 3) + 2}) as $record) {
    printf("%s=%d\\n", $record['name'], $record['score']);
}
`;
    },
  },
  {
    id: "custom-exception",
    structure: "port-value",
    operation: "validate-port",
    algorithm: "exceptions",
    instruction:
      "Crie uma exceção de validação e uma função que converte porta textual, rejeitando valores fora do intervalo.",
    explanation:
      "ctype_digit impede sinais e espaços, e o catch específico preserva o código de erro original.",
    tags: ["exceptions", "validation", "port"],
    difficulty: "intermediate",
    render: (c) => {
      const bad = 70000 + (c.n % 1000);
      return `declare(strict_types=1);

final class ValidationException extends RuntimeException
{
}

function parsePort(string $value): int
{
    if (!ctype_digit($value)) {
        throw new ValidationException("port must contain digits only: $value");
    }

    $port = (int) $value;
    if ($port < 1 || $port > 65535) {
        throw new ValidationException("port out of range: $port");
    }
    return $port;
}

try {
    printf("port=%d\\n", parsePort('${(c.n % 60000) + 1}'));
    parsePort('${bad}');
} catch (ValidationException $error) {
    fwrite(STDERR, $error->getMessage() . PHP_EOL);
    exit(1);
}
`;
    },
  },
  {
    id: "group-totals",
    structure: "record-array",
    operation: "group-totals",
    algorithm: "associative-array",
    instruction:
      "Agrupe valores por região em um array associativo, ordene as chaves e imprima os totais.",
    explanation:
      "O operador ??= inicializa o acumulador apenas na primeira ocorrência de cada região.",
    tags: ["grouping", "arrays", "ksort"],
    difficulty: "basic",
    render: (c) => {
      const regions = ["north", "south", "east", "west"];
      const rows = c.values
        .slice(0, 6)
        .map(
          (amount, i) =>
            `    ['region' => '${regions[i % regions.length]}', 'amount' => ${amount}],`,
        )
        .join("\n");
      return `declare(strict_types=1);

$rows = [
${rows}
];
$totals = [];

foreach ($rows as $row) {
    $region = $row['region'];
    $totals[$region] = ($totals[$region] ?? 0) + $row['amount'];
}

ksort($totals);
foreach ($totals as $region => $total) {
    printf("%s=%d\\n", $region, $total);
}
`;
    },
  },
  {
    id: "parse-line",
    structure: "delimited-line",
    operation: "parse-fields",
    algorithm: "explode-loop",
    instruction:
      "Converta uma linha delimitada em um mapa chave-valor, validando partes sem separador.",
    explanation:
      "O limite 2 no explode preserva sinais de igual no valor e a checagem de contagem rejeita entradas malformadas.",
    tags: ["parser", "explode", "validation"],
    difficulty: "intermediate",
    render: (c) => {
      return `declare(strict_types=1);

$line = 'user=${c.text};count=${c.n};mode=fast';
$fields = [];

foreach (explode(';', $line) as $part) {
    $pair = explode('=', $part, 2);
    if (count($pair) !== 2 || $pair[0] === '') {
        throw new InvalidArgumentException("invalid field: $part");
    }
    $fields[$pair[0]] = $pair[1];
}

printf(
    "user=%s count=%d keys=%d\\n",
    $fields['user'],
    (int) $fields['count'],
    count($fields)
);
`;
    },
  },
];

export function generate(): CodeSample[] {
  return composeLanguage({
    language: "php",
    label: "PHP",
    seed: 0x5eed_7007,
    scenarios,
    styles,
    edges: DEFAULT_EDGES,
    params: DEFAULT_PARAMS,
    min: 800,
  });
}
