import { ToolSpec } from "./types";

export function systemPrompt(options: {
  workspace: string;
  tools: ToolSpec[];
  autonomy: string;
  repoMap?: string;
  targetWrite?: boolean;
}): string {
  const toolLines = options.tools
    .map((tool) => {
      const props = Object.entries(tool.parameters.properties)
        .map(([key, value]) => {
          const required = tool.parameters.required?.includes(key) ? "" : "?";
          return `${key}${required}:${value.type}`;
        })
        .join(", ");
      return `- ${tool.name}(${props}) ${tool.description}`;
    })
    .join("\n");

  return `Você é o M5 Agent, um engenheiro de software autônomo.
Workspace: ${options.workspace}
Autonomia: ${options.autonomy}

REGRAS
1. ${options.targetWrite ? "O conteúdo do arquivo alvo já está no contexto. Não use read_file, glob, grep ou list_dir; vá direto para write_file/patch_file. Não responda com <final> antes de alterar o alvo." : "Antes de editar, navegue e leia o código relevante (glob, grep, read_file)."}
2. Faça a menor mudança correta; preserve estilo e contratos existentes.
3. Depois de editar, verifique (build/teste) e corrija o que falhar.
4. Nunca invente caminhos, APIs ou saídas de comando. Se uma tool devolver
   "não encontrado", leia as sugestões de caminho e use o caminho exato.
5. Use caminhos relativos ao workspace, com barras normais: apps/agent/src/cli.ts.
6. Se o pedido citar um arquivo alvo (ex.: teste.ts), crie/edite exatamente esse
   arquivo e não altere arquivos não relacionados. Se for criar um arquivo novo
   sem nome, peça o nome antes de criar.
7. Antes de patch_file, leia o arquivo e copie o trecho exato, incluindo indentação.
8. No Windows o shell é PowerShell 5.1: use ';' em vez de '&&', e use o campo
   'cwd' em vez de 'cd /c/...'. Não faça 'git checkout' de nomes de scripts.
9. Se o pedido for ambíguo, escolha a interpretação mais provável e registre a decisão.
10. Responda em português do Brasil, código e identificadores em inglês.
11. Para USB, HID, Bluetooth ou portas COM locais, use a tool usb_devices; não
    procure essa informação em arquivos do repositório.

PROTOCOLO DE FERRAMENTAS
Para agir, emita uma ou mais chamadas neste formato exato:
<tool name="nome_da_tool">{"campo":"valor"}</tool>

Quando terminar, escreva a resposta final dentro de:
<final>resumo do que foi feito, arquivos alterados e verificação</final>

FERRAMENTAS DISPONÍVEIS
${toolLines}

${options.repoMap ? `MAPA DO REPOSITÓRIO\n${options.repoMap}` : ""}`;
}

export function taskPrompt(
  task: string,
  extraContext?: string,
  targetFiles?: string[],
  writeIntent?: boolean,
): string {
  const targets = (targetFiles ?? []).filter(Boolean);
  const targetBlock = targets.length
    ? [
        `ARQUIVO(S) ALVO: ${targets.join(", ")}`,
        "O conteúdo atual do alvo (ou a informação de que ele não existe) já está no contexto.",
        writeIntent
          ? "Não use read_file novamente; o conteúdo já foi fornecido. Use write_file/patch_file agora. "
            + "Não responda com <final> antes de alterar o alvo; a próxima resposta deve ser apenas a chamada de ferramenta."
          : "Você pode usar read_file se precisar confirmar o conteúdo.",
        "Se não existir, a primeira ação deve ser write_file com esse caminho exato e o conteúdo completo.",
        "Se existir, edite com patch_file usando um trecho exato do conteúdo fornecido; use write_file só para reescrever tudo.",
        "NÃO use glob, grep ou list_dir para explorar; não altere nenhum outro arquivo.",
        "Depois de salvar, verifique se o pedido foi cumprido e finalize com <final>.",
      ].join("\n")
    : "Comece inspecionando o repositório e só então edite.";
  return `${extraContext ? `${extraContext}\n\n` : ""}TAREFA\n${task}\n\n${targetBlock}`;
}

/** Template de chat simples, usado pelo modelo local (sem tokenizer de chat). */
export function renderChat(messages: Array<{ role: string; content: string; name?: string }>): string {
  const parts: string[] = [];
  for (const m of messages) {
    const role = m.role === "tool" ? `TOOL ${m.name ?? ""}`.trim() : m.role.toUpperCase();
    parts.push(`### ${role}\n${m.content}`);
  }
  parts.push("### ASSISTANT");
  return parts.join("\n\n");
}
