/**
 * Motor comum dos geradores.
 *
 * Cada linguagem declara cenários (estrutura × operação × algoritmo),
 * variantes de estilo, casos de borda e conjuntos de parâmetros. O motor
 * monta o produto cartesiano, embaralha com seed fixa e materializa as
 * amostras com id determinístico.
 */
import type { CodeSample, Difficulty } from "../types.ts";
import {
  assertMinSamples,
  cartesian,
  dedupeById,
  estimateDifficulty,
  mulberry32,
  shuffle,
} from "../combinators.ts";

export interface StyleVariant {
  id: string;
  /** Instrução curta em PT-BR sobre o estilo. */
  pt: string;
  /** Nota usada na explicação. */
  note: string;
  suffix: string;
  header: (title: string) => string;
}

export interface EdgeVariant {
  id: string;
  pt: string;
  note: string;
  count: number;
  base: number;
}

export interface ParamSet {
  id: string;
  a: number;
  b: number;
  c: number;
  text: string;
}

export interface RenderCtx {
  language: string;
  scenario: Scenario;
  style: StyleVariant;
  edge: EdgeVariant;
  params: ParamSet;
  index: number;
  /** Inteiro pequeno e positivo, seguro para laços e recursões. */
  n: number;
  n2: number;
  /** Número derivado do caso de borda, útil em literais. */
  number: number;
  count: number;
  values: number[];
  magnitudes: number[];
  text: string;
  name(base: string): string;
}

export interface Scenario {
  id: string;
  structure: string;
  operation: string;
  algorithm: string;
  instruction: string;
  explanation: string;
  tags?: string[];
  difficulty?: Difficulty;
  render(ctx: RenderCtx): string;
}

export interface LanguageSpec {
  language: string;
  label: string;
  seed: number;
  scenarios: readonly Scenario[];
  styles: readonly StyleVariant[];
  edges: readonly EdgeVariant[];
  params: readonly ParamSet[];
  min?: number;
}

export const DEFAULT_EDGES: readonly EdgeVariant[] = [
  {
    id: "single",
    pt: "Caso de borda: coleção com um único elemento.",
    note: "A entrada mínima exercita o caminho sem iteração.",
    count: 1,
    base: 4,
  },
  {
    id: "duplicates",
    pt: "Caso de borda: elementos repetidos na entrada.",
    note: "Valores repetidos verificam que a agregação não perde ocorrências.",
    count: 6,
    base: 3,
  },
  {
    id: "negative",
    pt: "Caso de borda: valores negativos e zero.",
    note: "O sinal dos valores é preservado durante o processamento.",
    count: 5,
    base: -2,
  },
  {
    id: "large",
    pt: "Caso de borda: valores grandes.",
    note: "Valores grandes testam a largura dos acumuladores.",
    count: 12,
    base: 1000,
  },
];

export const DEFAULT_PARAMS: readonly ParamSet[] = [
  { id: "p1", a: 3, b: 5, c: 7, text: "alpha" },
  { id: "p2", a: 10, b: 2, c: 11, text: "beta" },
  { id: "p3", a: 7, b: 13, c: 4, text: "gamma" },
  { id: "p4", a: 21, b: 8, c: 6, text: "delta" },
];

const STYLE_SUFFIXES = ["", "_doc", "_explicit", "_safe", "_v2"] as const;

/**
 * Cinco estilos de código com cabeçalhos distintos e sufixos de identificador
 * válidos nas linguagens alvo (snake/camel, sem acentos).
 */
export function stylesFor(comment: string, withSuffix = true): StyleVariant[] {
  const header = (title: string, note: string): string =>
    `${comment} ${title}\n${comment} ${note}\n\n`;
  return [
    {
      id: "concise",
      pt: "Use estilo conciso, com um único comentário de identificação.",
      note: "A variante concisa privilegia leitura direta.",
      suffix: "",
      header: (title) => `${comment} ${title}\n\n`,
    },
    {
      id: "documented",
      pt: "Documente o objetivo no cabeçalho do código.",
      note: "O cabeçalho documenta o contrato do exemplo.",
      suffix: withSuffix ? STYLE_SUFFIXES[1] : "",
      header: (title) => header(title, "Documented reference implementation."),
    },
    {
      id: "explicit",
      pt: "Prefira nomes explícitos e fluxo de controle direto.",
      note: "Os identificadores explícitos deixam a intenção evidente.",
      suffix: withSuffix ? STYLE_SUFFIXES[2] : "",
      header: (title) => header(title, "Explicit naming and direct control flow."),
    },
    {
      id: "defensive",
      pt: "Inclua comentários de robustez e nomes descritivos.",
      note: "A variante defensiva enfatiza limites e validação.",
      suffix: withSuffix ? STYLE_SUFFIXES[3] : "",
      header: (title) => header(title, "Defensive variant with descriptive identifiers."),
    },
    {
      id: "compact",
      pt: "Mantenha a implementação compacta, sem perder clareza.",
      note: "A variante compacta reduz a cerimônia do exemplo.",
      suffix: withSuffix ? STYLE_SUFFIXES[4] : "",
      header: (title) => header(title, "Compact variant."),
    },
  ];
}

function valuesForEdge(edge: EdgeVariant, params: ParamSet): number[] {
  const a = Math.abs(params.a);
  const base = edge.base;
  if (edge.id === "single") return [base + a];
  if (edge.id === "duplicates") {
    const first = base + a;
    const second = base + Math.abs(params.b) + 1;
    return [first, first, second, first, second, base + Math.abs(params.c)];
  }
  if (edge.id === "negative") {
    return [-a, -Math.abs(params.b), 0, a, Math.abs(params.c)];
  }
  const step = Math.abs(params.b) + 1;
  return Array.from({ length: edge.count }, (_, i) => base + i * step);
}

function pad4(value: number): string {
  return String(value).padStart(4, "0");
}

/**
 * Materializa uma linguagem. Exige que o produto cartesiano tenha pelo menos
 * `min` combinações; a ordem é determinística para uma mesma seed.
 */
export function composeLanguage(spec: LanguageSpec): CodeSample[] {
  const min = spec.min ?? 800;
  const combos = cartesian({
    scenario: spec.scenarios,
    style: spec.styles,
    edge: spec.edges,
    params: spec.params,
  });
  if (combos.length < min) {
    throw new Error(
      `${spec.language}: only ${combos.length} combinations, need at least ${min}`,
    );
  }

  const rng = mulberry32(spec.seed);
  const ordered = shuffle(rng, combos).slice(0, min);
  const samples: CodeSample[] = ordered.map((combo, index) => {
    const values = valuesForEdge(combo.edge, combo.params);
    const n = (Math.abs(combo.edge.base) % 19) + combo.params.a + 1;
    const n2 = Math.abs(combo.params.c - combo.params.b) + 2;
    const ctx: RenderCtx = {
      language: spec.language,
      scenario: combo.scenario,
      style: combo.style,
      edge: combo.edge,
      params: combo.params,
      index,
      n,
      n2,
      number: Math.abs(combo.edge.base) + combo.params.a,
      count: combo.edge.count,
      values,
      magnitudes: values.map((value) => Math.abs(value) + 1),
      text: combo.params.text,
      name: (base: string) => `${base}${combo.style.suffix}`,
    };
    const title = `${combo.scenario.id} | ${combo.scenario.operation} / ${combo.scenario.algorithm} | ${combo.edge.id} / ${combo.params.id}`;
    const code = `${combo.style.header(title)}${combo.scenario.render(ctx)}`.replace(/\s+$/, "") + "\n";
    const instruction = `${combo.scenario.instruction} ${combo.style.pt} ${combo.edge.pt}`;
    const explanation = `${combo.scenario.explanation} ${combo.style.note} ${combo.edge.note}`;
    const tags = [
      spec.language,
      combo.scenario.structure,
      combo.scenario.operation,
      combo.scenario.algorithm,
      combo.style.id,
      combo.edge.id,
    ];
    return {
      id: `${spec.language}-${pad4(index + 1)}`,
      language: spec.language,
      task: `${combo.scenario.operation} ${combo.scenario.structure} using ${combo.scenario.algorithm} (${combo.style.id}, ${combo.edge.id})`,
      instruction,
      code,
      explanation,
      tags,
      difficulty: estimateDifficulty({
        base: combo.scenario.difficulty,
        algorithm: combo.scenario.algorithm,
        style: combo.style.id,
        edge: combo.edge.id,
      }),
    };
  });

  return assertMinSamples(dedupeById(samples), min, spec.language);
}
