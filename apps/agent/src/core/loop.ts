import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildRepoMap, renderContextChunks, retrieveContext } from "./context";
import { Policy, PolicyDecision } from "./policy";
import { formatToolResult, parseModelOutput, validateCall } from "./protocol";
import { systemPrompt, taskPrompt } from "./prompt";
import { requirementLabels, validateGeneratedContent } from "./requirements";
import { Session } from "./session";
import { AgentConfig, ChatMessage, ModelAdapter, RunResult, StepRecord, Tool, ToolContext } from "./types";
import { hasWriteIntent, truncate } from "./util";
import { runVerification, summarizeVerification } from "./verify";
import { BASE_TOOLS } from "../tools/registry";

const AGENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SELF_PROTECTED = [
  path.join(AGENT_ROOT, "src"),
  path.join(AGENT_ROOT, "scripts"),
  path.join(AGENT_ROOT, "test"),
  path.join(AGENT_ROOT, "package.json"),
  path.join(AGENT_ROOT, "tsconfig.json"),
];

function isSelfProtected(workspace: string, target: string): boolean {
  const full = path.resolve(workspace, target);
  return SELF_PROTECTED.some((entry) => full === entry || full.startsWith(entry + path.sep));
}

export interface AgentRunOptions {
  task: string;
  config: AgentConfig;
  model: ModelAdapter;
  tools?: Tool[];
  sessionId?: string;
  onStep?: (step: StepRecord) => void;
  approve?: (toolName: string, input: Record<string, unknown>, decision: PolicyDecision) => Promise<boolean> | boolean;
  /** Contexto extra injetado no primeiro turno. */
  context?: string;
  repoMap?: string;
  /** Texto usado na busca RAG; no chat deve ser só a mensagem atual. */
  retrievalQuery?: string;
  /** Arquivos citados pelo usuário; se preenchido, trava writes fora do alvo. */
  targetFiles?: string[];
}

export interface AgentRunResult extends RunResult {}

function now(): string {
  return new Date().toISOString();
}

function trimMessages(messages: ChatMessage[], maxChars: number): ChatMessage[] {
  if (messages.length <= 3) return messages;
  const system = messages[0];
  const task = messages[1];
  const tail: ChatMessage[] = [];
  let chars = 0;
  for (let i = messages.length - 1; i >= 2; i--) {
    const message = messages[i];
    if (chars + message.content.length > maxChars) break;
    tail.unshift(message);
    chars += message.content.length;
  }
  return [system, task, ...tail];
}

function safeRelative(workspace: string, target: string): string {
  const rel = path.relative(workspace, path.resolve(workspace, target));
  return rel.startsWith("..") ? target : rel.replace(/\\/g, "/");
}

/** Em modo alvo, evita que o modelo gaste turnos explorando o repositório. */
const TARGET_WRITE_TOOLS = new Set(["write_file", "patch_file", "shell"]);
const TARGET_READ_TOOLS = new Set(["read_file", "shell"]);
const WRITE_TOOL_NAMES = new Set(["write_file", "patch_file"]);
/** Tools de exploração que podem ser desativadas quando o modelo entra em loop. */
const EXPLORATION_TOOL_NAMES = new Set([
  "repo_map",
  "read_file",
  "glob",
  "grep",
  "list_dir",
  "search_code",
  "find_symbols",
  "index_build",
]);

function buildTargetContext(workspace: string, targets: string[]): string {
  if (targets.length === 0) return "";
  const perFile = Math.max(1_500, Math.floor(6_000 / targets.length));
  const blocks: string[] = [];
  for (const target of targets) {
    const full = path.resolve(workspace, target);
    try {
      if (fs.existsSync(full) && fs.statSync(full).isFile()) {
        const raw = fs.readFileSync(full, "utf8");
        const lines = raw.split(/\r?\n/).length;
        blocks.push(
          `ARQUIVO ALVO: ${target}\n`
          + `STATUS: existe (${lines} linhas)\n`
          + "CONTEÚDO ATUAL (use patch_file com um trecho exato):\n"
          + "```\n" + truncate(raw, perFile) + "\n```",
        );
      } else {
        blocks.push(
          `ARQUIVO ALVO: ${target}\n`
          + "STATUS: NÃO EXISTE. Crie agora com write_file contendo o conteúdo completo.",
        );
      }
    } catch {
      blocks.push(`ARQUIVO ALVO: ${target}\nSTATUS: não foi possível ler. Use write_file para recriar.`);
    }
  }
  return blocks.join("\n\n");
}

export async function runAgent(options: AgentRunOptions): Promise<AgentRunResult> {
  const { config, model, task } = options;
  const tools = options.tools ?? BASE_TOOLS;
  const policy = new Policy(config);
  const session = new Session(config, options.sessionId);
  const targetLockEnabled = options.targetFiles !== undefined;
  const requestedTargets = [
    ...new Set((options.targetFiles ?? []).map((file) => file.replace(/\\/g, "/"))),
  ];
  const targetFiles = new Set(
    requestedTargets.map((file) => safeRelative(config.workspace, file).toLowerCase()),
  );
  const targetMode = targetFiles.size > 0;
  const intentText = options.retrievalQuery ?? task;
  const taskWantsWrite = hasWriteIntent(intentText);
  const requirements = requirementLabels(intentText);
  const targetToolNames = taskWantsWrite ? TARGET_WRITE_TOOLS : TARGET_READ_TOOLS;
  const targetToolSet = targetMode
    ? tools.filter((tool) => targetToolNames.has(tool.spec.name))
    : tools;
  const activeTools = targetToolSet.length > 0 ? targetToolSet : tools;
  const toolMap = new Map(activeTools.map((tool) => [tool.spec.name, tool]));
  let specs = activeTools.map((tool) => tool.spec);

  const toolContext: ToolContext = {
    workspace: config.workspace,
    sessionId: session.id,
    config,
    policy,
    log: (message, data) => {
      policy.audit({ type: "log", sessionId: session.id, message, ...(data ?? {}) });
    },
  };

  const repoMap = targetMode
    ? ""
    : options.repoMap ?? buildRepoMap(config.workspace, { maxFiles: 250, maxChars: 4_500 });
  const retrieved = targetMode
    ? ""
    : options.context
      ?? renderContextChunks(retrieveContext(config.workspace, options.retrievalQuery ?? task, { limit: 4, maxChars: 2_000 }));
  const targetContext = targetMode ? buildTargetContext(config.workspace, requestedTargets) : "";
  const extraContext = [targetContext, retrieved].filter(Boolean).join("\n\n");

  const messages: ChatMessage[] = [
    {
      role: "system",
      content: systemPrompt({
        workspace: config.workspace,
        tools: specs,
        autonomy: config.autonomy,
        repoMap,
        targetWrite: targetMode && taskWantsWrite,
      }),
    },
    {
      role: "user",
      content: taskPrompt(
        task,
        extraContext || undefined,
        requestedTargets,
        targetMode && taskWantsWrite,
        requirements,
      ),
    },
  ];
  for (const message of messages) session.pushMessage(message);

  const started = Date.now();
  let stepsUsed = 0;
  let toolCalls = 0;
  let final = "";
  let status: RunResult["status"] = "max-steps";
  let stopReason: string | null = null;
  let forceDone = false;
  let forceFinal = "";
  let blockedWrites = 0;
  let blockedExplore = 0;
  let nudgedEmptyTarget = false;
  let forcedWriteTried = false;
  let forceWriteRequested = false;
  let toolAdjusted = false;
  let disabledToolCalls = 0;
  const disabledTools = new Set<string>();
  const callCounts = new Map<string, number>();
  const editCounts = new Map<string, number>();
  const writeSignatures = new Set<string>();

  const allTargetsChanged = (): boolean => {
    if (targetFiles.size === 0) return false;
    const changed = new Set([...session.changedFiles].map((file) => file.toLowerCase()));
    return [...targetFiles].every((file) => changed.has(file));
  };

  const targetDoneFinal = (): string =>
    `Arquivo(s) alvo já alterado(s): ${requestedTargets.join(", ")}. `
    + "Ações adicionais fora do alvo foram ignoradas.";

  const callSignature = (call: ReturnType<typeof parseModelOutput>["calls"][number]): string =>
    `${call.name}:${JSON.stringify(call.input)}`;

  const repeatedCall = (call: ReturnType<typeof parseModelOutput>["calls"][number]): boolean => {
    // Uma tool já removida não deve voltar a acionar o loop-guard. O modelo
    // recebe um erro claro de "TOOL DESATIVADA" e pode escolher outra tool.
    if (disabledTools.has(call.name)) return false;
    const key = callSignature(call);
    const count = callCounts.get(key) ?? 0;
    if (count >= 2) return true;
    callCounts.set(key, count + 1);
    return false;
  };

  const record = (step: Omit<StepRecord, "index" | "ts">): void => {
    const full: StepRecord = { index: session.steps.length, ts: now(), ...step };
    session.recordStep(full);
    options.onStep?.(full);
  };

  /**
   * Em vez de encerrar na primeira repetição, remove a tool de exploração que
   * travou o modelo e dá mais um turno com o catálogo ajustado. Em tarefa de
   * escrita com alvo, a tentativa focada de escrita continua sendo prioritária.
   */
  const disableExplorationTool = (name: string): boolean => {
    if (targetMode && taskWantsWrite) return false;
    if (!EXPLORATION_TOOL_NAMES.has(name) || disabledTools.has(name)) return false;
    disabledTools.add(name);
    specs = specs.filter((spec) => spec.name !== name);
    toolMap.delete(name);
    session.pushMessage({
      role: "user",
      content:
        `[TOOLS] A ferramenta ${name} foi desativada porque o modelo repetiu a mesma chamada. `
        + "Continue a tarefa com as ferramentas restantes; não repita a chamada removida.",
    });
    record({
      kind: "tool",
      name: "tool-adjust",
      output: `Ferramenta ${name} desativada após repetição.`,
      ok: true,
    });
    toolAdjusted = true;
    return true;
  };

  const blockExplore = (
    call: ReturnType<typeof parseModelOutput>["calls"][number],
    output: string,
  ): false => {
    session.pushMessage({ role: "tool", name: call.name, content: formatToolResult(call.name, { ok: false, output }) });
    record({ kind: "tool", name: call.name, input: call.input, output, ok: false });
    if (targetMode && allTargetsChanged()) {
      forceDone = true;
      forceFinal = targetDoneFinal();
      return false;
    }
    // Em tarefa de escrita com alvo explícito, explorar/ler de novo é sinal de
    // que o modelo travou. Em vez de encerrar, tenta uma chamada focada de escrita.
    if (targetMode && taskWantsWrite && session.changedFiles.size === 0 && !forcedWriteTried) {
      forceWriteRequested = true;
      return false;
    }
    blockedExplore += 1;
    if (blockedExplore >= 2) {
      stopReason =
        `Interrompi: o modelo tentou explorar o repositório duas vezes em vez de agir no alvo (${call.name}). `
        + "O conteúdo do arquivo alvo já foi enviado; use write_file ou patch_file.";
      record({ kind: "error", name: "target-guard", output: stopReason, ok: false });
    }
    return false;
  };

  const blockWrite = (
    call: ReturnType<typeof parseModelOutput>["calls"][number],
    output: string,
  ): false => {
    session.pushMessage({ role: "tool", name: call.name, content: formatToolResult(call.name, { ok: false, output }) });
    record({ kind: "tool", name: call.name, input: call.input, output, ok: false });
    if (targetMode && allTargetsChanged()) {
      forceDone = true;
      forceFinal = targetDoneFinal();
      return false;
    }
    // Escrita no caminho errado tambem e um sintoma de alvo perdido. Tenta a
    // conversa focada com o caminho exato antes de encerrar por write-guard.
    if (targetMode && taskWantsWrite && session.changedFiles.size === 0 && !forcedWriteTried) {
      forceWriteRequested = true;
      return false;
    }
    blockedWrites += 1;
    if (blockedWrites >= 3) {
      stopReason =
        `Interrompi: ${blockedWrites} tentativas de escrita bloqueadas. `
        + "Cite o arquivo alvo explicitamente ou finalize.";
      record({ kind: "error", name: "write-guard", output: stopReason, ok: false });
    }
    return false;
  };

  const budgetLeft = (): boolean =>
    stepsUsed < config.limits.maxSteps
    && toolCalls < config.limits.maxToolCalls
    && Date.now() - started < config.limits.maxWallClockMs
    && !policy.stopped();

  const modelTurn = async (): Promise<{ final: string | null; calls: ReturnType<typeof parseModelOutput>["calls"] } | null> => {
    const budgetChars = Math.max(4_000, config.model.maxTokens * 8);
    const requestMessages = trimMessages(messages, budgetChars);
    const turnStart = Date.now();
    let text: string;
    try {
      const response = await model.complete({
        messages: requestMessages,
        tools: specs,
        maxTokens: config.model.maxTokens,
        temperature: config.model.temperature,
      });
      text = response.text ?? "";
      record({
        kind: "model",
        name: model.id,
        output: text.slice(0, 2_000),
        ok: true,
        ms: Date.now() - turnStart,
      });
    } catch (err) {
      record({ kind: "error", name: model.id, output: (err as Error).message, ok: false, ms: Date.now() - turnStart });
      return null;
    }

    session.pushMessage({ role: "assistant", content: text });
    const parsed = parseModelOutput(text, specs);
    if (parsed.calls.length === 0) {
      return { final: parsed.final ?? parsed.prose ?? "", calls: [] };
    }
    return { final: null, calls: parsed.calls };
  };

  const executeCall = async (call: ReturnType<typeof parseModelOutput>["calls"][number]): Promise<boolean> => {
    let writeSignature: string | null = null;
    const tool = toolMap.get(call.name);
    if (!tool) {
      if (disabledTools.has(call.name)) {
        disabledToolCalls += 1;
        const available = specs.map((spec) => spec.name).join(", ") || "(nenhuma)";
        const output =
          `[TOOL DESATIVADA] ${call.name} foi removida após repetição. `
          + `Use apenas: ${available}. Se você já tem informação suficiente, finalize com <final>.`;
        session.pushMessage({ role: "tool", name: call.name, content: formatToolResult(call.name, { ok: false, output }) });
        record({ kind: "tool", name: call.name, input: call.input, output, ok: false });
        if (disabledToolCalls >= 3) {
          stopReason =
            `Não consegui avançar: o modelo insistiu em ${call.name}, que foi desativada por repetição. `
            + "Informe o arquivo alvo exato ou reformule a tarefa com um caminho "
            + "(ex.: apps/agent/src/arquivo.ts).";
          record({ kind: "error", name: "tool-disabled-guard", output: stopReason, ok: false });
        }
        return false;
      }
      if (targetMode) {
        return blockExplore(
          call,
          `[ALVO] A tool ${call.name} não está disponível nesta tarefa. `
          + `O conteúdo do arquivo alvo já foi fornecido. Use write_file/patch_file em ${requestedTargets.join(", ")}.`,
        );
      }
      const output = `Tool desconhecida: ${call.name}`;
      session.pushMessage({ role: "tool", name: call.name, content: formatToolResult(call.name, { ok: false, output }) });
      record({ kind: "tool", name: call.name, input: call.input, output, ok: false });
      return false;
    }

    const invalid = validateCall(call, tool.spec);
    if (invalid) {
      const output = `Chamada inválida: ${invalid}`;
      session.pushMessage({ role: "tool", name: call.name, content: formatToolResult(call.name, { ok: false, output }) });
      record({ kind: "tool", name: call.name, input: call.input, output, ok: false });
      return false;
    }

    if (
      targetMode
      && session.changedFiles.size === 0
      && call.name === "shell"
      && /^\s*(gci|get-childitem|dir|ls|find|select-string|rg|grep)\b/i.test(String(call.input.command ?? ""))
    ) {
      return blockExplore(
        call,
        `[ALVO] Não explore o repositório. Trabalhe diretamente em ${requestedTargets.join(", ")} com write_file ou patch_file.`,
      );
    }

    if (call.name === "write_file" || call.name === "patch_file") {
      const rawPath = typeof call.input.path === "string" ? call.input.path : "";
      const key = safeRelative(config.workspace, rawPath).toLowerCase();
      const fullPath = path.resolve(config.workspace, rawPath);
      if (targetLockEnabled && targetFiles.size === 0 && call.name === "write_file" && !fs.existsSync(fullPath)) {
        const output =
          `[NOVO ARQUIVO BLOQUEADO] Para criar ${rawPath || "(caminho vazio)"}, `
          + "cite o nome do arquivo na tarefa (ex.: 'crie teste.ts'). "
          + "Isso evita que o modelo crie arquivos aleatórios.";
        return blockWrite(call, output);
      }
      if (targetFiles.size > 0 && !targetFiles.has(key)) {
        const output =
          `[ALVO BLOQUEADO] A tarefa cita apenas: ${[...targetFiles].join(", ")}. `
          + `Não altere ${rawPath || "(caminho vazio)"}. Crie/edite o arquivo alvo ou finalize.`;
        return blockWrite(call, output);
      }
      if (targetFiles.size === 0 && isSelfProtected(config.workspace, rawPath)) {
        const output =
          `[AUTO-PROTEÇÃO] ${rawPath} faz parte do código do próprio agente. `
          + "Cite o arquivo explicitamente na tarefa para autorizar essa edição.";
        return blockWrite(call, output);
      }
      if (call.name === "write_file") {
        const content = typeof call.input.content === "string" ? call.input.content : "";
        const quality = validateGeneratedContent(intentText, rawPath, content);
        if (quality) {
          const requirementNote = requirements.length
            ? ` Requisitos: ${requirements.join(", ")}.`
            : "";
          return blockWrite(
            call,
            `[QUALIDADE] ${quality.message}. `
            + "Reescreva o arquivo completo com implementação real, sem TODO/pass/placeholder."
            + requirementNote,
          );
        }
        writeSignature = `${key}:${content}`;
        if (writeSignatures.has(writeSignature)) {
          const output = `[REPETIDO] ${rawPath} já foi escrito com esse mesmo conteúdo. Finalize ou altere o conteúdo.`;
          session.pushMessage({ role: "tool", name: call.name, content: formatToolResult(call.name, { ok: false, output }) });
          record({ kind: "tool", name: call.name, input: call.input, output, ok: false });
          const alreadyChanged = [...session.changedFiles].some((file) => file.toLowerCase() === key);
          if (alreadyChanged) {
            forceDone = true;
            forceFinal = `Arquivo ${rawPath} criado/alterado com sucesso. A escrita idêntica repetida foi ignorada.`;
          }
          return false;
        }
      }
      if (call.name === "patch_file" && fs.existsSync(fullPath)) {
        const oldString = String(call.input.oldString ?? "");
        const newString = String(call.input.newString ?? "");
        const replaceAll = call.input.replaceAll === true;
        if (oldString && oldString !== newString) {
          const original = fs.readFileSync(fullPath, "utf8").replace(/\r\n/g, "\n");
          const normalizedOld = oldString.replace(/\r\n/g, "\n");
          const occurrences = original.split(normalizedOld).length - 1;
          if (occurrences > 0 && (replaceAll || occurrences === 1)) {
            const patched = replaceAll
              ? original.split(normalizedOld).join(newString.replace(/\r\n/g, "\n"))
              : original.replace(normalizedOld, newString.replace(/\r\n/g, "\n"));
            const quality = validateGeneratedContent(intentText, rawPath, patched);
            if (quality) {
              const requirementNote = requirements.length
                ? ` Requisitos: ${requirements.join(", ")}.`
                : "";
              return blockWrite(
                call,
                `[QUALIDADE] ${quality.message}. `
                + "O patch deixaria o arquivo incompleto. Use write_file com a implementação completa."
                + requirementNote,
              );
            }
          }
        }
      }
    }

    const decision = policy.classifyCommand(
      tool.spec.group === "shell" || tool.spec.group === "net"
        ? String(call.input.command ?? call.input.target ?? "")
        : tool.spec.name,
    );

    if (config.autonomy === "plan") {
      const output = `[modo plano] ${call.name} não executado. Entrada: ${JSON.stringify(call.input)}`;
      session.pushMessage({ role: "tool", name: call.name, content: formatToolResult(call.name, { ok: true, output }) });
      record({ kind: "tool", name: call.name, input: call.input, output, ok: true });
      return true;
    }

    if (policy.requiresApproval(decision) && options.approve) {
      const approved = await options.approve(call.name, call.input, decision);
      if (!approved) {
        const output = `Ação recusada pelo operador (${decision.classification}: ${decision.reasons.join("; ")}).`;
        session.pushMessage({ role: "tool", name: call.name, content: formatToolResult(call.name, { ok: false, output }) });
        record({ kind: "tool", name: call.name, input: call.input, output, ok: false });
        return false;
      }
    }

    const callStart = Date.now();
    let result;
    try {
      result = await tool.run(call.input, toolContext);
    } catch (err) {
      result = { ok: false, output: `Erro em ${call.name}: ${(err as Error).message}` };
    }
    const ms = Date.now() - callStart;
    if (result.ok) disabledToolCalls = 0;
    if (writeSignature && result.ok) writeSignatures.add(writeSignature);

    // Patch com oldString errado e o erro mais comum do modelo pequeno. Se o
    // alvo ainda nao mudou, pede uma reescrita focada com write_file em vez de
    // deixar o modelo repetir o mesmo patch ou vazar para outro arquivo.
    if (
      targetMode
      && taskWantsWrite
      && session.changedFiles.size === 0
      && !result.ok
      && (call.name === "write_file" || call.name === "patch_file")
    ) {
      const rawPath = typeof call.input.path === "string" ? call.input.path : "";
      const key = safeRelative(config.workspace, rawPath).toLowerCase();
      if (targetFiles.has(key) && !forcedWriteTried) forceWriteRequested = true;
    }

    // Se o alvo já foi alterado e o modelo tenta reaplicar o mesmo patch, a
    // falha de "trecho não encontrado" geralmente significa que a edição já
    // está aplicada. Finaliza em vez de gastar turnos ou tentar outros arquivos.
    if (
      targetMode
      && !result.ok
      && call.name === "patch_file"
      && allTargetsChanged()
    ) {
      const rawPath = typeof call.input.path === "string" ? call.input.path : "";
      const key = safeRelative(config.workspace, rawPath).toLowerCase();
      if (targetFiles.has(key)) {
        const oldString = String(call.input.oldString ?? "").replace(/\r\n/g, "\n");
        const newString = String(call.input.newString ?? "").replace(/\r\n/g, "\n");
        try {
          const current = fs.readFileSync(path.resolve(config.workspace, rawPath), "utf8").replace(/\r\n/g, "\n");
          if (oldString && newString && !current.includes(oldString) && current.includes(newString)) {
            forceDone = true;
            forceFinal = `Arquivo alvo ${rawPath} já contém a alteração pedida. A edição repetida foi ignorada.`;
          }
        } catch {
          /* mantém o erro original */
        }
      }
    }

    if (call.name === "read_file" && targetFiles.size > 0) {
      const rawPath = typeof call.input.path === "string" ? call.input.path : "";
      const key = safeRelative(config.workspace, rawPath).toLowerCase();
      const target = [...targetFiles].join(", ");
      const hint = targetFiles.has(key)
        ? !result.ok
          ? `[ALVO] Este é o arquivo alvo e ele não existe. Crie-o agora com write_file usando path="${target}" e o conteúdo pedido. Não leia outros arquivos.`
          : `[ALVO] Arquivo alvo lido. Se precisar editar, use patch_file em "${target}". Não altere outros arquivos.`
        : `[ALVO] A tarefa atual é somente sobre: ${target}. Use esse caminho exato e não leia arquivos não relacionados.`;
      result = { ...result, output: `${result.output}\n\n${hint}` };
    }

    if (typeof result.meta?.changed === "string") {
      const changed = safeRelative(config.workspace, result.meta.changed);
      session.recordChange(changed);
      blockedWrites = 0;
      const edits = (editCounts.get(changed) ?? 0) + 1;
      editCounts.set(changed, edits);
      // Uma edição muda o estado do workspace; leituras iguais depois disso
      // podem ser legítimas.
      callCounts.clear();
      if (edits >= 3) {
        stopReason =
          `Interrompi: ${changed} foi alterado ${edits} vezes na mesma tarefa. `
          + "Reformule com um alvo menor ou use um modelo maior.";
        record({ kind: "error", name: "edit-guard", output: stopReason, ok: false });
      }
    }

    session.pushMessage({
      role: "tool",
      name: call.name,
      content: formatToolResult(call.name, { ok: result.ok, output: result.output }),
    });
    record({
      kind: "tool",
      name: call.name,
      input: call.input,
      output: result.output.slice(0, 4_000),
      ok: result.ok,
      ms,
    });
    return result.ok;
  };

  const finishForcedWrite = (): void => {
    status = "done";
    final = forceDone && forceFinal
      ? forceFinal
      : `Arquivo(s) alvo alterado(s): ${requestedTargets.join(", ")}.`;
  };

  /**
   * Ultima tentativa deterministica: conversa nova, so ferramentas de escrita e
   * o conteudo do alvo. Modelos pequenos costumam sair do loop quando a
   * historico cheio de leituras/ferramentas desconhecidas e removido.
   */
  const forcedWrite = async (): Promise<boolean> => {
    if (!targetMode || !taskWantsWrite || session.changedFiles.size > 0 || forcedWriteTried) {
      return false;
    }
    forcedWriteTried = true;
    const writeTools = tools.filter((tool) => WRITE_TOOL_NAMES.has(tool.spec.name));
    if (writeTools.length === 0) return false;
    const writeSpecs = writeTools.map((tool) => tool.spec);
    const forcedMessages: ChatMessage[] = [
      {
        role: "system",
        content: [
          "Voce e um agente de codigo em uma tentativa focada de escrita.",
          `Arquivo(s) alvo: ${requestedTargets.join(", ")}.`,
          `Use exatamente esse caminho relativo ao workspace, sem prefixar pastas: ${requestedTargets.join(", ")}.`,
          "Responda SOMENTE com uma chamada de ferramenta. Nao use <final>, nao explique e nao leia arquivos.",
          "Nao use a sintaxe write_file(...). Use exatamente a tag XML abaixo:",
          `<tool name="write_file">{"path":"${requestedTargets[0]}","content":"CONTEUDO COMPLETO AQUI"}</tool>`,
          `<tool name="patch_file">{"path":"${requestedTargets[0]}","oldString":"TRECHO EXATO","newString":"NOVO TRECHO"}</tool>`,
          "Troque CONTEUDO COMPLETO AQUI pelo codigo final pedido.",
          "Se o alvo nao existe, use write_file com o conteudo completo.",
          "Se o alvo existe, prefira write_file para reescrever o arquivo inteiro com o conteudo final.",
          "Nao copie o conteudo atual se ele nao implementa todos os requisitos; reescreva de verdade.",
          requirements.length
            ? `REQUISITOS OBRIGATORIOS: ${requirements.join(", ")}. Implemente cada um com codigo real, sem stub/TODO/pass.`
            : "",
          "Use patch_file apenas se o oldString existir exatamente no CONTEUDO ATUAL. Se um patch falhar, nao o repita: use write_file.",
          "Nao use read_file, glob, grep, list_dir ou shell.",
        ].filter(Boolean).join("\n"),
      },
      {
        role: "user",
        content: `${task}\n\n${targetContext}\n\nACAO OBRIGATORIA: escreva agora no alvo usando write_file ou patch_file.`
          + (requirements.length ? `\nImplemente todos os requisitos: ${requirements.join(", ")}.` : ""),
      },
    ];

    const turnStart = Date.now();
    let text: string;
    try {
      const response = await model.complete({
        messages: forcedMessages,
        tools: writeSpecs,
        maxTokens: Math.max(config.model.maxTokens, 2_048),
        temperature: 0.1,
      });
      text = response.text ?? "";
      record({
        kind: "model",
        name: `${model.id}:forced-write`,
        output: text.slice(0, 2_000),
        ok: true,
        ms: Date.now() - turnStart,
      });
    } catch (err) {
      record({
        kind: "error",
        name: `${model.id}:forced-write`,
        output: (err as Error).message,
        ok: false,
        ms: Date.now() - turnStart,
      });
      return false;
    }

    const parsed = parseModelOutput(text, writeSpecs);
    const calls = parsed.calls.filter((call) => WRITE_TOOL_NAMES.has(call.name));
    if (calls.length === 0) return false;
    session.pushMessage({ role: "assistant", content: text });
    for (const call of calls) {
      if (toolCalls >= config.limits.maxToolCalls) break;
      toolCalls += 1;
      await executeCall(call);
      if (session.changedFiles.size > 0 || forceDone) return true;
      if (stopReason) return false;
    }
    return false;
  };

  const drive = async (): Promise<void> => {
    while (budgetLeft()) {
      stepsUsed += 1;
      const turn = await modelTurn();
      if (turn === null) {
        status = "error";
        final = "Falha ao consultar o modelo.";
        return;
      }
      if (turn.calls.length === 0) {
        const candidate = turn.final || "(modelo não produziu resposta final)";
        const claimsWrite =
          /\b(criei|criado|criada|salvei|salvo|salva|gravei|gravado|gerado|gerada|alterei|alterado|alterada|modifiquei|modificado|editado|editada|atualizei|atualizado|implementei|implementado|corrigi|corrigido|edição|alteração|modificação|criação|implementação|mudança|atualização|gravação|salvamento|patch_file|write_file)\b/i.test(candidate);
        const deniesWrite =
          /\b(não|nao)\s+(alterei|editei|modifiquei|criei|salvei|gravei|consegui|foi\s+(possível|possivel|feita|feito|alterado|alterada|editado|editada|criado|criada|salvo|salva|gravado|gravada|modificado|modificada))\b/i.test(candidate)
          || /\b(nada|nenhum|nenhuma)\s+(foi|arquivo|alteração|alteracao|mudança|mudanca)\b/i.test(candidate)
          || /\b(nada|nenhum|nenhuma)\s+(criado|criada|alterado|alterada|editado|editada|modificado|modificada|salvo|salva|gravado|gravada|feito|feita)\b/i.test(candidate)
          || /\bsem\s+(alteração|alteracao|alterações|alteracoes|mudança|mudanca|mudanças|mudancas|modificação|modificacao|modificações|modificacoes)\b/i.test(candidate);

        if (
          targetMode
          && taskWantsWrite
          && session.changedFiles.size === 0
          && !nudgedEmptyTarget
          && !deniesWrite
        ) {
          if (!forcedWriteTried && await forcedWrite()) {
            finishForcedWrite();
            return;
          }
          nudgedEmptyTarget = true;
          const target = requestedTargets.join(", ");
          session.pushMessage({
            role: "user",
            content:
              `[ALVO] Você ainda não criou/alterou ${target}. Não finalize. `
              + "Use write_file se o arquivo não existe ou patch_file se ele já existe, agora. "
              + "Responda apenas com a chamada de ferramenta.",
          });
          record({
            kind: "error",
            name: "target-retry",
            output: `Modelo tentou finalizar sem alterar ${target}; pedindo ação de escrita.`,
            ok: false,
          });
          continue;
        }

        status = "done";
        final = candidate;
        if (session.changedFiles.size === 0 && (blockedWrites > 0 || (claimsWrite && !deniesWrite))) {
          const detail = blockedWrites > 0 ? ` (${blockedWrites} escrita(s) bloqueada(s))` : "";
          final = `[AVISO] Nenhum arquivo foi criado ou alterado${detail}.\n${candidate}`;
          if (!deniesWrite) status = "error";
        }
        return;
      }
      for (const call of turn.calls) {
        if (toolCalls >= config.limits.maxToolCalls) break;
        if (repeatedCall(call)) {
          if (!forcedWriteTried && await forcedWrite()) {
            finishForcedWrite();
            return;
          }
          if (disableExplorationTool(call.name)) break;
          const detail = `${call.name} ${JSON.stringify(call.input).slice(0, 200)}`;
          const output = `Chamada repetida bloqueada: ${detail}`;
          record({ kind: "error", name: "loop-guard", output, ok: false });
          status = "error";
          final = `Interrompi porque o modelo repetiu a mesma chamada várias vezes (${call.name}). Reformule a tarefa ou use um modelo maior.`;
          return;
        }
        toolCalls += 1;
        await executeCall(call);
        if (forceDone) {
          status = "done";
          final = forceFinal;
          return;
        }
        if (stopReason) {
          status = "error";
          final = stopReason;
          return;
        }
      }
      if (toolAdjusted) {
        toolAdjusted = false;
        continue;
      }
      if (forceWriteRequested && !stopReason && !forceDone) {
        forceWriteRequested = false;
        if (await forcedWrite()) {
          finishForcedWrite();
          return;
        }
        status = "error";
        final =
          `[AVISO] Nenhum arquivo foi criado ou alterado. `
          + `O modelo nao conseguiu produzir uma escrita valida para ${requestedTargets.join(", ")}.`;
        record({ kind: "error", name: "target-forced-write-failed", output: final, ok: false });
        return;
      }
    }
    status = policy.stopped()
      ? "error"
      : Date.now() - started >= config.limits.maxWallClockMs
        ? "timeout"
        : "max-steps";
    final = final || `Limite atingido (${status}) sem resposta final.`;
  };

  await drive();

  // Verificação por build/teste, com uma rodada de reparo automática.
  const changed = [...session.changedFiles];
  let verify = await runVerification(config, { changed: changed.length > 0, changedFiles: changed });
  if (verify.ran) {
    record({
      kind: "verify",
      name: "verify",
      output: summarizeVerification(verify) + "\n" + verify.steps.map((s) => `$ ${s.command}\n${s.output}`).join("\n"),
      ok: verify.ok,
    });
  }

  if (verify.ran && !verify.ok && budgetLeft()) {
    const failure = verify.steps.map((s) => `$ ${s.command} (exit ${s.code})\n${s.output}`).join("\n\n");
    session.pushMessage({
      role: "user",
      content: `A verificação automática falhou. Corrija o código e finalize.\n\n${failure.slice(0, 6_000)}`,
    });
    status = "max-steps";
    final = "";
    await drive();
    verify = await runVerification(config, { changed: true, changedFiles: changed });
    if (verify.ran) {
      record({
        kind: "verify",
        name: "verify-repair",
        output: summarizeVerification(verify),
        ok: verify.ok,
      });
    }
  }

  const verifySummary = verify.ran
    ? `\n\nVerificação: ${verify.ok ? "OK" : "FALHOU"} (${verify.steps.map((s) => s.command).join(", ")})`
    : "";
  const finalWithVerify = `${final}${verifySummary}`;

  const result: AgentRunResult = {
    sessionId: session.id,
    status,
    final: finalWithVerify,
    steps: session.steps,
    transcriptPath: session.transcriptPath,
    changedFiles: changed,
  };
  session.finish(result);

  // Resumo legível para o operador.
  const summaryDir = path.join(config.workspace, ".m5", "sessions", session.id);
  try {
    fs.writeFileSync(
      path.join(summaryDir, "summary.md"),
      [
        `# Sessão ${session.id}`,
        "",
        `Status: ${status}`,
        `Arquivos alterados: ${changed.length ? changed.join(", ") : "nenhum"}`,
        "",
        "## Resultado",
        finalWithVerify,
        "",
        "## Passos",
        ...session.steps.map((s) => `- ${s.kind} ${s.name ?? ""} ${s.ok === false ? "FALHOU" : "ok"} ${s.ms ?? ""}ms`),
      ].join("\n"),
    );
  } catch {
    /* resumo é best-effort */
  }

  return result;
}
