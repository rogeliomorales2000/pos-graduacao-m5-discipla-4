import fs from "node:fs";
import { ChatMessage, ModelAdapter, ModelRequest, ModelResponse } from "../core/types";
import { renderChat } from "../core/prompt";
import { GptModel } from "./gpt";
import { BpeTokenizer } from "./bpe";

/** Adapter do modelo próprio (checkpoint local treinado por train-cli.ts). */
export class LocalModelAdapter implements ModelAdapter {
  readonly id: string;

  private constructor(
    private readonly model: GptModel,
    private readonly tokenizer: BpeTokenizer,
    name: string,
  ) {
    this.id = `local:${name}`;
  }

  static load(file: string, name = "m5coder"): LocalModelAdapter {
    if (!fs.existsSync(file)) {
      throw new Error(
        `Checkpoint não encontrado: ${file}\nTreine primeiro: npm run agent:train -- --smoke (ou --steps 400)`,
      );
    }
    const { model, tokenizer } = GptModel.load(file);
    return new LocalModelAdapter(model, tokenizer, name);
  }

  get contextSize(): number {
    return this.model.config.ctx;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const prompt = renderChat(request.messages as ChatMessage[]);
    const maxNew = Math.max(1, request.maxTokens ?? 256);
    const promptIds = this.tokenizer.encode(prompt);
    const keep = Math.max(8, this.model.config.ctx - maxNew);
    const ctxIds = promptIds.slice(-keep);

    const generated = this.model.generate(ctxIds, {
      maxNewTokens: maxNew,
      temperature: request.temperature ?? 0.7,
      topP: 0.95,
    });
    let text = this.tokenizer.decode(generated.slice(ctxIds.length));

    // Modelos pequenos tendem a "continuar o documento": corta no próximo turno.
    const stopMarkers = ["\n### USER", "\n### TOOL", "\n### SYSTEM", "</final>"];
    for (const marker of stopMarkers) {
      const at = text.indexOf(marker);
      if (at >= 0) {
        text = marker === "</final>" ? text.slice(0, at + "</final>".length) : text.slice(0, at);
      }
    }

    return {
      text,
      model: this.id,
      usage: { prompt: ctxIds.length, completion: generated.length - ctxIds.length },
    };
  }
}
