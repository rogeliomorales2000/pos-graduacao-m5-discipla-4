import { AgentConfig, ModelAdapter } from "../core/types";
import { HttpModelAdapter } from "./http";
import { LocalModelAdapter } from "./local";

export function createModel(config: AgentConfig): ModelAdapter {
  if (config.model.kind === "http") {
    if (!config.model.baseUrl) {
      throw new Error("model.kind=http exige model.baseUrl (ex.: http://localhost:11434/v1)");
    }
    const configured = Number(process.env.M5_HTTP_TIMEOUT_MS ?? 300_000);
    const timeoutMs = Number.isFinite(configured) && configured > 0 ? configured : 300_000;
    return new HttpModelAdapter({
      baseUrl: config.model.baseUrl,
      model: config.model.name ?? "qwen2.5-coder",
      apiKeyEnv: config.model.apiKeyEnv,
      timeoutMs,
    });
  }
  if (!config.model.path) throw new Error("model.kind=local exige model.path");
  return LocalModelAdapter.load(config.model.path, config.model.name ?? "m5coder");
}
