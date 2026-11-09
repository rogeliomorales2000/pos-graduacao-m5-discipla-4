/** Contrato público de uma amostra de código do dataset multi-linguagem. */
export type Difficulty = "basic" | "intermediate" | "advanced";

export interface CodeSample {
  id: string;
  language: string;
  task: string;
  instruction: string;
  code: string;
  explanation: string;
  tags: string[];
  difficulty: Difficulty;
}
