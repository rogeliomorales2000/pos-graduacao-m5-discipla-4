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
    id: "pipeline-files",
    structure: "file-collection",
    operation: "measure-size",
    algorithm: "cmdlet-pipeline",
    instruction:
      "Crie arquivos de log temporários, meça o total de bytes com o pipeline e remova a pasta no final.",
    explanation:
      "Where-Object filtra por tamanho e Measure-Object agrega comprimento e contagem em uma passagem.",
    tags: ["pipeline", "get-childitem", "measure-object"],
    difficulty: "basic",
    render: (c) => {
      const files = (c.n % 5) + 2;
      return `$root = Join-Path -Path $PSScriptRoot -ChildPath "${c.text}-logs"
New-Item -ItemType Directory -Path $root -Force | Out-Null

1..${files} | ForEach-Object {
    $path = Join-Path $root "entry-$($_).log"
    Set-Content -LiteralPath $path -Value ("line-" * ${(c.n % 4) + 1})
}

$summary = Get-ChildItem -Path $root -File -Filter '*.log' |
    Where-Object { $_.Length -gt 0 } |
    Measure-Object -Property Length -Sum

[PSCustomObject]@{
    Files = $summary.Count
    Bytes = [int64]$summary.Sum
}

Remove-Item -LiteralPath $root -Recurse -Force
`;
    },
  },
  {
    id: "group-object",
    structure: "record-array",
    operation: "group-and-total",
    algorithm: "group-object",
    instruction:
      "Agrupe registros por região com Group-Object e projete contagem e soma por grupo.",
    explanation:
      "Group-Object cria grupos com a propriedade Group, permitindo agregar cada subcoleção com Measure-Object.",
    tags: ["group-object", "records", "pipeline"],
    difficulty: "intermediate",
    render: (c) => {
      const regions = ["north", "south", "east", "west"];
      const rows = c.values
        .slice(0, 6)
        .map(
          (amount, i) =>
            `    [PSCustomObject]@{ Region = '${regions[i % regions.length]}'; Amount = ${amount} }`,
        )
        .join("\n");
      return `$rows = @(
${rows}
)

$rows |
    Group-Object -Property Region |
    ForEach-Object {
        [PSCustomObject]@{
            Region = $_.Name
            Count = $_.Count
            Total = ($_.Group | Measure-Object -Property Amount -Sum).Sum
        }
    } |
    Sort-Object -Property Total -Descending |
    Format-Table -AutoSize
`;
    },
  },
  {
    id: "try-catch-file",
    structure: "file-operation",
    operation: "read-with-errors",
    algorithm: "try-catch-finally",
    instruction:
      "Leia um arquivo com tratamento de erro específico, aviso genérico e bloco finally.",
    explanation:
      "O primeiro catch trata erro de arquivo e o catch genérico registra a mensagem da exceção sem interromper o finally.",
    tags: ["try-catch", "files", "errors"],
    difficulty: "intermediate",
    render: (c) => {
      return `$path = Join-Path -Path $PSScriptRoot -ChildPath "${c.text}-missing.txt"

try {
    if (-not (Test-Path -LiteralPath $path)) {
        throw [System.IO.FileNotFoundException]::new("file not found: $path")
    }
    Get-Content -LiteralPath $path
}
catch [System.IO.FileNotFoundException] {
    Write-Warning "expected file was not created: $path"
}
catch {
    Write-Error "unexpected failure: $($_.Exception.Message)"
}
finally {
    Write-Verbose "read attempt finished for ${c.text}"
}
`;
    },
  },
  {
    id: "advanced-function",
    structure: "cmdlet-function",
    operation: "validated-output",
    algorithm: "parameter-validation",
    instruction:
      "Crie uma função avançada com CmdletBinding, parâmetros validados e saída de objetos no process.",
    explanation:
      "ValidateRange e ValidateSet rejeitam entradas inválidas antes do corpo; a saída permanece no pipeline.",
    tags: ["function", "cmdletbinding", "validation"],
    difficulty: "intermediate",
    render: (c) => {
      const fn = c.name("Get-Summary");
      return `function ${fn} {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [ValidateRange(1, 100)]
        [int]$Count,

        [ValidateSet('${c.text}', 'backup')]
        [string]$Name = '${c.text}'
    )

    process {
        1..$Count | ForEach-Object {
            [PSCustomObject]@{
                Name = $Name
                Index = $_
                Square = $_ * $_
            }
        }
    }
}

${fn} -Count ${(c.n % 5) + 1} -Name '${c.text}' | Format-Table -AutoSize
`;
    },
  },
  {
    id: "csv-roundtrip",
    structure: "csv-table",
    operation: "write-read",
    algorithm: "import-export-csv",
    instruction:
      "Gere uma tabela CSV temporária com Export-Csv, recarregue com Import-Csv e some a coluna Amount.",
    explanation:
      "Export-Csv -NoTypeInformation mantém o cabeçalho limpo e Import-Csv reconstrói objetos tipados como texto.",
    tags: ["csv", "import-csv", "export-csv"],
    difficulty: "intermediate",
    render: (c) => {
      const rows = c.values
        .slice(0, 5)
        .map((amount, i) => `    [PSCustomObject]@{ Id = ${i + 1}; Amount = ${amount} }`)
        .join("\n");
      return `$path = Join-Path -Path ([System.IO.Path]::GetTempPath()) -ChildPath "${c.text}-report.csv"

$rows = @(
${rows}
)
$rows | Export-Csv -LiteralPath $path -NoTypeInformation -Encoding utf8

$loaded = Import-Csv -LiteralPath $path
$total = ($loaded | Measure-Object -Property Amount -Sum).Sum

[PSCustomObject]@{
    Rows = $loaded.Count
    Total = [int]$total
    Path = $path
}

Remove-Item -LiteralPath $path -Force
`;
    },
  },
  {
    id: "process-report",
    structure: "process-list",
    operation: "top-memory",
    algorithm: "sort-select",
    instruction:
      "Liste os processos que mais consomem memória, selecionando nome, id e working set.",
    explanation:
      "Sort-Object ordena pelo working set e Select-Object -First limita a saída sem carregar tudo.",
    tags: ["get-process", "sort", "select"],
    difficulty: "basic",
    render: (c) => {
      return `$limit = ${(c.n % 4) + 3}
$processes = Get-Process |
    Sort-Object -Property WorkingSet64 -Descending |
    Select-Object -First $limit -Property Name, Id, WorkingSet64

$processes | Format-Table -AutoSize
Write-Verbose "reported $($processes.Count) processes for ${c.text}"
`;
    },
  },
  {
    id: "admin-registry",
    structure: "windows-registry",
    operation: "read-build-info",
    algorithm: "admin-check",
    instruction:
      "Verifique se o processo é administrador e leia a versão do Windows no registro com Test-Path.",
    explanation:
      "O principal Windows verifica o papel Administrador; a leitura do registro é protegida por Test-Path.",
    tags: ["admin", "registry", "windows"],
    difficulty: "advanced",
    render: (c) => {
      return `$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$key = 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion'

if (Test-Path -LiteralPath $key) {
    Get-ItemProperty -LiteralPath $key |
        Select-Object -Property ProductName, CurrentBuild, UBR
}
else {
    Write-Warning "registry key not available: $key"
}

if (-not $isAdmin) {
    Write-Warning "running without administrator rights (limit=${c.n})"
}
`;
    },
  },
  {
    id: "hashtable-totals",
    structure: "hashtable",
    operation: "accumulate",
    algorithm: "dictionary-loop",
    instruction:
      "Acumule valores por região em uma hashtable e produza um relatório ordenado.",
    explanation:
      "ContainsKey distingue ausência de zero e o enumerador da hashtable pode ser ordenado por Value.",
    tags: ["hashtable", "accumulate", "report"],
    difficulty: "intermediate",
    render: (c) => {
      const regions = ["north", "south", "east", "west"];
      const rows = c.values
        .slice(0, 6)
        .map(
          (amount, i) =>
            `    [PSCustomObject]@{ Region = '${regions[i % regions.length]}'; Amount = ${amount} }`,
        )
        .join("\n");
      return `$rows = @(
${rows}
)
$totals = @{}

foreach ($row in $rows) {
    if (-not $totals.ContainsKey($row.Region)) {
        $totals[$row.Region] = 0
    }
    $totals[$row.Region] += $row.Amount
}

$totals.GetEnumerator() |
    Sort-Object -Property Value -Descending |
    ForEach-Object {
        [PSCustomObject]@{ Region = $_.Key; Total = $_.Value }
    } |
    Format-Table -AutoSize
`;
    },
  },
  {
    id: "regex-parse",
    structure: "log-line",
    operation: "extract-fields",
    algorithm: "regex-named-groups",
    instruction:
      "Extraia usuário e contagem de uma linha de log com grupos nomeados, rejeitando formato inválido.",
    explanation:
      "O operador -match popula $Matches com grupos nomeados; a negação lança erro quando o formato não bate.",
    tags: ["regex", "matches", "validation"],
    difficulty: "intermediate",
    render: (c) => {
      return `$line = 'user=${c.text};count=${c.n};region=south'
$pattern = '^user=(?<user>[^;]+);count=(?<count>\\d+);'

if ($line -match $pattern) {
    [PSCustomObject]@{
        User = $Matches['user']
        Count = [int]$Matches['count']
        Limit = ${c.n2}
    }
}
else {
    throw "invalid log line: $line"
}
`;
    },
  },
  {
    id: "rest-retry",
    structure: "http-client",
    operation: "retry-request",
    algorithm: "retry-loop",
    instruction:
      "Faça uma requisição REST com até três tentativas, timeout curto e nova tentativa em caso de erro.",
    explanation:
      "O try/catch conta tentativas e relança o erro apenas quando o limite é atingido; Start-Sleep evita espera ocupada.",
    tags: ["http", "retry", "invoke-restmethod"],
    difficulty: "advanced",
    render: (c) => {
      const attempts = (c.n % 2) + 2;
      return `$uri = "https://example.invalid/api/items?limit=${c.n}"
$attempt = 0
$maxAttempts = ${attempts}

while ($attempt -lt $maxAttempts) {
    try {
        $response = Invoke-RestMethod -Uri $uri -TimeoutSec ${(c.n % 3) + 2} -Method Get
        $response | ConvertTo-Json -Depth 3
        break
    }
    catch {
        $attempt++
        if ($attempt -ge $maxAttempts) {
            throw "request failed after $maxAttempts attempts: $($_.Exception.Message)"
        }
        Start-Sleep -Milliseconds 200
    }
}
`;
    },
  },
];

export function generate(): CodeSample[] {
  return composeLanguage({
    language: "ps1",
    label: "PowerShell",
    seed: 0x5eed_6006,
    scenarios,
    styles,
    edges: DEFAULT_EDGES,
    params: DEFAULT_PARAMS,
    min: 800,
  });
}
