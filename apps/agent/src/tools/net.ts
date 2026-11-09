import dns from "node:dns/promises";
import net from "node:net";
import { Tool } from "../core/types";
import { truncate } from "../core/util";

export interface ProbeResult {
  target: string;
  port: number | null;
  reachable: boolean;
  latencyMs: number;
  detail: string;
}

export function tcpProbe(host: string, port: number, timeoutMs = 3_000): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = new net.Socket();
    let settled = false;
    const finish = (reachable: boolean, detail: string): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ target: host, port, reachable, latencyMs: Date.now() - started, detail });
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true, "tcp connect ok"));
    socket.once("timeout", () => finish(false, "timeout"));
    socket.once("error", (err: Error) => finish(false, err.message));
    socket.connect(port, host);
  });
}

export const netProbeTool: Tool = {
  spec: {
    name: "net_probe",
    group: "net",
    dangerous: true,
    description:
      "Verifica alcançabilidade TCP/DNS de um host. Toda chamada é registrada no audit log com o escopo autorizado (ou 'não verificado').",
    parameters: {
      type: "object",
      properties: {
        target: { type: "string", description: "Host, IP ou URL." },
        port: { type: "integer", description: "Porta TCP (padrão 443)." },
        timeoutMs: { type: "integer" },
      },
      required: ["target"],
    },
  },
  async run(input, ctx) {
    const raw = String(input.target ?? "").trim();
    if (!raw) return { ok: false, output: "Informe target." };
    const decision = ctx.policy.classifyCommand(`ping ${raw}`);
    const scope = ctx.policy.matchScope(raw.replace(/^https?:\/\//, "").split("/")[0].split(":")[0]);

    ctx.policy.audit({
      type: "net_probe",
      sessionId: ctx.sessionId,
      target: raw,
      scope: scope?.target ?? null,
      reasons: decision.reasons,
    });

    const host = raw.replace(/^https?:\/\//, "").split("/")[0].split(":")[0];
    const port = Number(input.port ?? (raw.startsWith("https") ? 443 : raw.startsWith("http") ? 80 : 443));
    const timeoutMs = Math.max(200, Number(input.timeoutMs ?? 3_000));

    let addresses: string[] = [];
    try {
      addresses = (await dns.lookup(host, { all: true })).map((a) => a.address);
    } catch (err) {
      return {
        ok: false,
        output: `DNS falhou para ${host}: ${(err as Error).message}`,
      };
    }

    const probe = await tcpProbe(host, port, timeoutMs);
    const lines = [
      `target=${host} port=${port}`,
      `dns=${addresses.join(", ")}`,
      `tcp=${probe.reachable ? "open" : "closed/filtered"} ${probe.latencyMs}ms (${probe.detail})`,
      `escopo=${scope ? `autorizado por ${scope.note ?? scope.target}` : "NÃO verificado no ledger .m5/scope.json"}`,
      decision.reasons.length ? `política=${decision.reasons.join("; ")}` : "",
    ].filter(Boolean);
    return {
      ok: probe.reachable,
      output: truncate(lines.join("\n"), ctx.config.limits.maxToolOutputChars),
      meta: { reachable: probe.reachable, scope: scope?.target ?? null },
    };
  },
};
