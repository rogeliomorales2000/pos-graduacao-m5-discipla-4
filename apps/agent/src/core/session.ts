import fs from "node:fs";
import path from "node:path";
import { AgentConfig, ChatMessage, RunResult, StepRecord } from "./types";
import { appendJsonl, ensureDir, newId, writeJson } from "./util";

export class Session {
  readonly id: string;
  readonly dir: string;
  readonly transcriptPath: string;
  readonly steps: StepRecord[] = [];
  readonly changedFiles = new Set<string>();
  readonly messages: ChatMessage[] = [];

  constructor(readonly config: AgentConfig, id?: string) {
    this.id = id ?? newId("m5");
    this.dir = path.join(config.workspace, ".m5", "sessions", this.id);
    this.transcriptPath = path.join(this.dir, "transcript.jsonl");
    ensureDir(this.dir);
  }

  recordStep(step: StepRecord): void {
    this.steps.push(step);
    appendJsonl(this.transcriptPath, step);
  }

  recordChange(relativePath: string): void {
    this.changedFiles.add(relativePath);
  }

  pushMessage(message: ChatMessage): void {
    this.messages.push(message);
  }

  finish(result: RunResult): void {
    writeJson(path.join(this.dir, "result.json"), result);
    writeJson(path.join(this.dir, "changes.json"), [...this.changedFiles]);
    try {
      fs.appendFileSync(
        path.join(this.config.workspace, ".m5", "sessions", "index.jsonl"),
        JSON.stringify({
          id: this.id,
          ts: new Date().toISOString(),
          status: result.status,
          steps: result.steps.length,
          changed: [...this.changedFiles],
          final: result.final.slice(0, 300),
        }) + "\n",
      );
    } catch {
      /* índice é best-effort */
    }
  }
}
