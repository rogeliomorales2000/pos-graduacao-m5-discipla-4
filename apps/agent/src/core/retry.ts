import { AgentRunOptions, AgentRunResult, runAgent } from "./loop";
import { AgentConfig, StepRecord } from "./types";
import { hasWriteIntent, newId, truncate } from "./util";

export interface CorrectiveRunOptions extends AgentRunOptions {
  /** Total de tentativas, incluindo a primeira. */
  attempts?: number;
  /** Reclamação do usuário que disparou o modo corretivo. */
  correction?: string;
}

export interface CorrectiveRunResult extends AgentRunResult {
  attempts: number;
  retryReasons: string[];
}

const REFUSAL =
  /\b(kill switch|recusad[ao]|pedido recusado|não posso ajudar|nao posso ajudar|bloquead[oa] por pol[ií]tica)\b/i;

/** Heurística para detectar que o usuário rejeitou o resultado anterior. */
export function isDissatisfied(text: string): boolean {
  return (
    /\b(não|nao)\s+(gostei|estou\s+satisfeit[oa]|fiquei\s+satisfeit[oa]|satisfeit[oa]|funcionou|alterou|editou|modificou|criou|salvou|entregou|foi\s+entregue|est[aá]\s+(bom|certo|correto)|ficou\s+(bom|certo|correto)|era\s+isso|e\s+isso|é\s+isso)\b/i.test(text)
    || /\b(est[aá]\s+(errado|incorreto)|errado|incorreto|refa[çc]a|ainda\s+n[aã]o|faltou|n[aã]o\s+é\s+isso|nao\s+e\s+isso|n[aã]o\s+era\s+isso|nao\s+era\s+isso)\b/i.test(text)
  );
}

function buildRetryTask(
  baseTask: string,
  attempt: number,
  total: number,
  previous: AgentRunResult,
  correction?: string,
): string {
  const changed = previous.changedFiles.length ? previous.changedFiles.join(", ") : "nenhum";
  return [
    baseTask,
    "",
    `[CORREÇÃO AUTOMÁTICA ${attempt}/${total}]`,
    `A tentativa anterior terminou com status=${previous.status}.`,
    `Resultado anterior: ${truncate(previous.final, 1_200)}`,
    `Arquivos alterados na tentativa anterior: ${changed}.`,
    correction ? `Insatisfação do usuário: ${correction}` : "",
    "Não repita a mesma chamada de ferramenta que falhou.",
    "Use exatamente o caminho do arquivo alvo. Não invente sucesso.",
    "Se o alvo não existe, use write_file com o conteúdo completo.",
    "Se o alvo existe, use write_file para reescrever ou patch_file com um trecho exato.",
    "Responda apenas com a chamada de ferramenta até alterar o arquivo; só use <final> depois de alterar.",
  ].filter(Boolean).join("\n");
}

function retryable(result: AgentRunResult, expectsFile: boolean): boolean {
  if (result.status === "plan") return false;
  if (REFUSAL.test(result.final)) return false;
  if (
    !expectsFile
    && result.steps.some((step) => step.name === "loop-guard" || step.name === "tool-disabled-guard")
  ) {
    return false;
  }
  return true;
}

/**
 * Executa a tarefa com um orçamento de tentativas.
 *
 * - Falha/timeout/max-steps: tenta de novo com um relatório do erro.
 * - Tarefa de escrita com alvo que terminou "done" sem alterar arquivo: tenta de novo.
 * - `correction`: reinicia a tarefa com a insatisfação do usuário e feedback corretivo.
 * - O limite é sempre finito (default 3 tentativas totais).
 */
export async function runAgentWithRetry(
  options: CorrectiveRunOptions,
): Promise<CorrectiveRunResult> {
  const maxAttempts = Math.max(
    1,
    Math.floor(options.attempts ?? options.config.limits.maxTaskAttempts ?? 3),
  );
  const sessionId = options.sessionId ?? newId("m5");
  const baseTask = options.correction && !options.task.includes(options.correction)
    ? `${options.task}\n\n[CORREÇÃO SOLICITADA PELO USUÁRIO]\n${options.correction}`
    : options.task;
  const firstIntent = options.retrievalQuery
    ? (options.correction && !options.retrievalQuery.includes(options.correction)
        ? `${options.retrievalQuery}\n${options.correction}`
        : options.retrievalQuery)
    : baseTask;
  const expectsFile = hasWriteIntent(firstIntent) && (options.targetFiles?.length ?? 0) > 0;
  const changed = new Set<string>();
  const allSteps: StepRecord[] = [];
  const retryReasons: string[] = [];
  let last: AgentRunResult | null = null;
  let attempts = 0;

  const appendSteps = (steps: StepRecord[]): void => {
    for (const step of steps) {
      allSteps.push({ ...step, index: allSteps.length });
    }
  };

  const emitRetry = (message: string): void => {
    const step: StepRecord = {
      index: allSteps.length,
      ts: new Date().toISOString(),
      kind: "error",
      name: "retry",
      output: message,
      ok: false,
    };
    allSteps.push(step);
    options.onStep?.(step);
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    attempts = attempt;
    const task = attempt === 1
      ? baseTask
      : buildRetryTask(baseTask, attempt, maxAttempts, last!, options.correction);
    const attemptConfig: AgentConfig = attempt === 1
      ? options.config
      : {
          ...options.config,
          model: {
            ...options.config.model,
            temperature: Math.max(0, Math.min(options.config.model.temperature, 0.2)),
          },
        };

    const result = await runAgent({
      task,
      config: attemptConfig,
      model: options.model,
      tools: options.tools,
      sessionId,
      onStep: options.onStep,
      approve: options.approve,
      context: options.context,
      repoMap: options.repoMap,
      retrievalQuery: attempt === 1 ? firstIntent : task,
      targetFiles: options.targetFiles,
    });

    last = result;
    for (const file of result.changedFiles) changed.add(file);
    appendSteps(result.steps);

    const delivered = result.status === "done" && (!expectsFile || changed.size > 0);
    if (delivered) break;
    if (attempt >= maxAttempts) break;
    if (!retryable(result, expectsFile)) break;

    const reason =
      `Tentativa ${attempt}/${maxAttempts}: status=${result.status}`
      + (expectsFile && changed.size === 0 ? " sem alterar o alvo" : "");
    retryReasons.push(reason);
    emitRetry(`Tentativa ${attempt}/${maxAttempts} não entregou; iniciando correção ${attempt + 1}/${maxAttempts}.`);
  }

  if (!last) {
    throw new Error("runAgentWithRetry terminou sem resultado");
  }

  const merged: CorrectiveRunResult = {
    ...last,
    sessionId,
    changedFiles: [...changed],
    steps: allSteps,
    attempts,
    retryReasons,
  };

  if (merged.status === "done" && expectsFile && changed.size === 0) {
    merged.status = "error";
    merged.final = `[AVISO] Nenhum arquivo foi criado ou alterado após ${attempts} tentativa(s).\n${last.final}`;
  }
  if (attempts > 1) {
    merged.final = `[CORREÇÃO] ${attempts} tentativa(s).\n${merged.final}`;
  }
  return merged;
}
