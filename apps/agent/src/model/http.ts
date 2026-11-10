import { ModelAdapter, ModelRequest, ModelResponse } from "../core/types";

/**
 * Adapter OpenAI-compatible (Ollama, LM Studio, vLLM, OpenRouter, etc.).
 * O loop do agente continua sendo nosso: isto apenas troca o "cérebro".
 */
export class HttpModelAdapter implements ModelAdapter {
  readonly id: string;

  constructor(
    private readonly options: {
      baseUrl: string;
      model: string;
      apiKeyEnv?: string;
      timeoutMs?: number;
    },
  ) {
    this.id = `http:${options.model}`;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const apiKey = this.options.apiKeyEnv ? process.env[this.options.apiKeyEnv] : undefined;
    const url = `${this.options.baseUrl.replace(/\/$/, "")}/chat/completions`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 900_000);

    try {
      const response = await fetch(url, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.options.model,
          messages: request.messages.map((m) => ({
            role: m.role === "tool" ? "assistant" : m.role,
            content: m.content,
          })),
          max_tokens: request.maxTokens ?? 1_024,
          temperature: request.temperature ?? 0.2,
          stop: request.stop,
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`HTTP ${response.status} em ${url}: ${body.slice(0, 500)}`);
      }
      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const text = data.choices?.[0]?.message?.content ?? "";
      return {
        text,
        model: this.id,
        usage: {
          prompt: data.usage?.prompt_tokens ?? 0,
          completion: data.usage?.completion_tokens ?? 0,
        },
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
