import type { CodeSample } from "../types.ts";
import {
  DEFAULT_EDGES,
  DEFAULT_PARAMS,
  composeLanguage,
  stylesFor,
  type Scenario,
} from "./_engine.ts";

const styles = stylesFor("--", false);

const scenarios: Scenario[] = [
  {
    id: "join-aggregate",
    structure: "customers-orders",
    operation: "aggregate-by-region",
    algorithm: "inner-join-group-by",
    instruction:
      "Some pedidos por região nos últimos 30 dias com INNER JOIN, GROUP BY e HAVING.",
    explanation:
      "O JOIN restringe os clientes com pedidos e o HAVING filtra os grupos já agregados.",
    tags: ["join", "group-by", "aggregate"],
    difficulty: "basic",
    render: (c) => {
      return `SELECT c.region,
       COUNT(*) AS order_count,
       SUM(o.amount) AS total_amount
FROM customers AS c
JOIN orders AS o ON o.customer_id = c.id
WHERE o.created_at >= CURRENT_DATE - INTERVAL '30 days'
GROUP BY c.region
HAVING SUM(o.amount) > ${c.n * 10}
ORDER BY total_amount DESC
LIMIT ${(c.n % 5) + 3};
`;
    },
  },
  {
    id: "window-ranking",
    structure: "orders",
    operation: "top-per-customer",
    algorithm: "row-number-window",
    instruction:
      "Ranqueie pedidos por cliente com ROW_NUMBER em uma CTE e mantenha apenas os primeiros.",
    explanation:
      "A janela calcula a posição dentro de cada cliente sem colapsar as linhas, e a CTE permite filtrar o ranking.",
    tags: ["window-function", "row-number", "cte"],
    difficulty: "intermediate",
    render: (c) => {
      return `WITH ranked AS (
    SELECT id,
           customer_id,
           amount,
           ROW_NUMBER() OVER (
               PARTITION BY customer_id
               ORDER BY amount DESC, id ASC
           ) AS position
    FROM orders
    WHERE amount > 0
)
SELECT customer_id, id, amount, position
FROM ranked
WHERE position <= ${(c.n % 4) + 2}
ORDER BY customer_id, position;
`;
    },
  },
  {
    id: "recursive-org",
    structure: "employee-tree",
    operation: "walk-hierarchy",
    algorithm: "recursive-cte",
    instruction:
      "Percorra a hierarquia de funcionários com CTE recursiva, controlando a profundidade máxima.",
    explanation:
      "O caso base seleciona os nós sem gerente e a parte recursiva desce um nível por iteração.",
    tags: ["recursive-cte", "hierarchy", "with-recursive"],
    difficulty: "advanced",
    render: (c) => {
      return `WITH RECURSIVE org AS (
    SELECT id,
           manager_id,
           1 AS depth
    FROM employees
    WHERE manager_id IS NULL

    UNION ALL

    SELECT employee.id,
           employee.manager_id,
           org.depth + 1
    FROM employees AS employee
    JOIN org ON employee.manager_id = org.id
    WHERE org.depth < ${(c.n % 4) + 3}
)
SELECT depth, COUNT(*) AS employee_count
FROM org
GROUP BY depth
ORDER BY depth;
`;
    },
  },
  {
    id: "index-explain",
    structure: "orders-index",
    operation: "optimize-query",
    algorithm: "composite-index-explain",
    instruction:
      "Crie um índice composto concorrente para pedidos e verifique o plano com EXPLAIN ANALYZE.",
    explanation:
      "A ordem customer_id, created_at atende igualdade seguida de ordenação; CONCURRENTLY evita bloquear escritas.",
    tags: ["index", "explain", "performance"],
    difficulty: "advanced",
    render: (c) => {
      return `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_orders_customer_created
    ON orders (customer_id, created_at DESC);

EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT id, customer_id, amount
FROM orders
WHERE customer_id = ${c.n}
  AND created_at >= CURRENT_DATE - INTERVAL '7 days'
ORDER BY created_at DESC
LIMIT ${(c.n % 8) + 5};
`;
    },
  },
  {
    id: "transaction-upsert",
    structure: "inventory",
    operation: "increment-stock",
    algorithm: "upsert-transaction",
    instruction:
      "Dentro de uma transação, insira ou incremente estoque com ON CONFLICT e registre a movimentação.",
    explanation:
      "O upsert usa EXCLUDED para acessar o valor proposto e toda a operação é confirmada atomicamente.",
    tags: ["transaction", "upsert", "on-conflict"],
    difficulty: "intermediate",
    render: (c) => {
      const delta = (c.n % 10) + 1;
      return `BEGIN;

INSERT INTO inventory (sku, quantity, updated_at)
VALUES ('${c.text}', ${delta}, NOW())
ON CONFLICT (sku) DO UPDATE
SET quantity = inventory.quantity + EXCLUDED.quantity,
    updated_at = EXCLUDED.updated_at;

INSERT INTO inventory_movements (sku, delta, reason)
VALUES ('${c.text}', ${delta}, 'restock');

COMMIT;
`;
    },
  },
  {
    id: "case-pivot",
    structure: "orders-status",
    operation: "pivot-status",
    algorithm: "conditional-aggregation",
    instruction:
      "Pivote valores por status usando agregação condicional com CASE e uma linha por região.",
    explanation:
      "Cada SUM(CASE ...) transforma uma categoria em coluna sem exigir uma extensão de pivot.",
    tags: ["pivot", "case", "aggregate"],
    difficulty: "intermediate",
    render: (c) => {
      return `SELECT region,
       SUM(CASE WHEN status = 'paid' THEN amount ELSE 0 END) AS paid_total,
       SUM(CASE WHEN status = 'pending' THEN amount ELSE 0 END) AS pending_total,
       SUM(CASE WHEN status = 'refunded' THEN amount ELSE 0 END) AS refunded_total,
       COUNT(*) AS order_count
FROM orders
WHERE created_at >= CURRENT_DATE - INTERVAL '${(c.n % 90) + 1} days'
GROUP BY region
ORDER BY paid_total DESC
LIMIT ${(c.n % 6) + 2};
`;
    },
  },
  {
    id: "keyset-pagination",
    structure: "orders-page",
    operation: "paginate",
    algorithm: "keyset-pagination",
    instruction:
      "Implemente paginação por keyset usando comparação de tupla e ordenação descendente.",
    explanation:
      "A comparação (created_at, id) < (...) evita o custo crescente de OFFSET e mantém a ordem estável.",
    tags: ["pagination", "keyset", "row-comparison"],
    difficulty: "advanced",
    render: (c) => {
      return `SELECT id, customer_id, created_at, amount
FROM orders
WHERE (created_at, id) < ($1, $2)
ORDER BY created_at DESC, id DESC
LIMIT ${(c.n % 20) + 10};

-- Parâmetros: $1 = created_at do último item, $2 = id do último item.
-- Busque a próxima página repetindo a consulta com o novo par retornado.
`;
    },
  },
  {
    id: "jsonb-extract",
    structure: "events-jsonb",
    operation: "extract-fields",
    algorithm: "jsonb-operators",
    instruction:
      "Extraia campos de uma coluna JSONB, filtre por conteúdo e ordene pelo score convertido.",
    explanation:
      "O operador ->> devolve texto, o cast ::int restaura o número e @> usa o índice GIN quando disponível.",
    tags: ["jsonb", "postgresql", "extract"],
    difficulty: "intermediate",
    render: (c) => {
      return `SELECT id,
       payload ->> 'name' AS name,
       (payload ->> 'score')::int AS score,
       payload -> 'tags' AS tags
FROM events
WHERE payload @> '{"kind":"purchase"}'
  AND (payload ->> 'score')::int >= ${c.n}
ORDER BY score DESC, id ASC
LIMIT ${(c.n % 15) + 5};
`;
    },
  },
  {
    id: "monthly-delta",
    structure: "monthly-totals",
    operation: "compare-months",
    algorithm: "cte-lag-window",
    instruction:
      "Calcule o total mensal e a diferença em relação ao mês anterior usando LAG sobre uma CTE.",
    explanation:
      "A CTE agrega uma vez por mês e LAG acessa a linha anterior sem subconsulta correlacionada.",
    tags: ["cte", "lag", "window-function"],
    difficulty: "advanced",
    render: (c) => {
      return `WITH monthly AS (
    SELECT date_trunc('month', created_at) AS month,
           SUM(amount) AS total
    FROM orders
    WHERE created_at >= CURRENT_DATE - INTERVAL '12 months'
    GROUP BY 1
)
SELECT month,
       total,
       total - LAG(total) OVER (ORDER BY month) AS delta,
       ROUND(
           100.0 * (total - LAG(total) OVER (ORDER BY month))
           / NULLIF(LAG(total) OVER (ORDER BY month), 0),
           2
       ) AS percent_change
FROM monthly
ORDER BY month DESC
LIMIT ${(c.n % 6) + 6};
`;
    },
  },
  {
    id: "anti-join",
    structure: "customers-without-orders",
    operation: "find-inactive",
    algorithm: "exists-anti-join",
    instruction:
      "Liste clientes sem pedidos acima de um limite usando NOT EXISTS e paginação.",
    explanation:
      "NOT EXISTS para no primeiro registro correspondente e costuma superar NOT IN quando há NULLs.",
    tags: ["exists", "anti-join", "pagination"],
    difficulty: "intermediate",
    render: (c) => {
      return `SELECT customer.id,
       customer.email,
       customer.created_at
FROM customers AS customer
WHERE NOT EXISTS (
    SELECT 1
    FROM orders AS order_row
    WHERE order_row.customer_id = customer.id
      AND order_row.amount > ${c.n * 5}
)
ORDER BY customer.created_at DESC, customer.id DESC
LIMIT ${(c.n % 12) + 8};
`;
    },
  },
];

export function generate(): CodeSample[] {
  return composeLanguage({
    language: "sql",
    label: "SQL (PostgreSQL)",
    seed: 0x5eed_8008,
    scenarios,
    styles,
    edges: DEFAULT_EDGES,
    params: DEFAULT_PARAMS,
    min: 800,
  });
}
