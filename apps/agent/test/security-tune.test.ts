import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  generateSecurityTuneSamples,
  splitSecuritySamples,
  writeSecurityTuneDataset,
} from "../src/datasets/security-tune";
import {
  SECURITY_SYSTEM_PROMPT,
  exportFinetuneDataset,
  toChatSample,
} from "../scripts/export-finetune";

const UNSAFE = /shellcode|msfvenom|reverse shell|meterpreter|mimikatz|cobalt strike/i;

test("dataset de segurança cobre defesa, purple, red autorizado e limites", () => {
  const samples = generateSecurityTuneSamples();
  assert.ok(samples.length >= 500, `esperado >= 500, recebido ${samples.length}`);

  const ids = new Set(samples.map((sample) => sample.id));
  assert.equal(ids.size, samples.length, "ids devem ser únicos");

  const categories = new Set(samples.map((sample) => sample.category));
  for (const expected of [
    "cve-analysis",
    "purple-detection",
    "purple-validation",
    "threat-hunting",
    "incident-response",
    "vulnerability-prioritization",
    "patch-validation",
    "secure-code",
    "red-team-authorized",
    "reporting",
    "safety-boundary",
  ]) {
    assert.ok(categories.has(expected as never), `categoria ausente: ${expected}`);
  }

  for (const sample of samples) {
    assert.ok(sample.instruction.length > 10, `instruction curta: ${sample.id}`);
    assert.ok(sample.output.length >= 80, `output curta: ${sample.id}`);
    assert.equal(sample.meta.defensive, true);
    assert.equal(sample.meta.authorized, true);
    assert.equal(sample.meta.no_exploit, true);
    assert.doesNotMatch(JSON.stringify(sample), UNSAFE, `termo inseguro: ${sample.id}`);
  }

  const safety = samples.filter((sample) => sample.category === "safety-boundary");
  assert.ok(safety.length >= 15);
  assert.ok(safety.every((sample) => sample.meta.track === "safety"));
});

test("divisão determinística mantém ~90/5/5 e não perde amostras", () => {
  const samples = generateSecurityTuneSamples();
  const first = splitSecuritySamples(samples);
  const second = splitSecuritySamples(samples);

  assert.deepEqual(
    first.train.map((sample) => sample.id),
    second.train.map((sample) => sample.id),
  );
  const total = first.train.length + first.validation.length + first.test.length;
  assert.equal(total, samples.length);
  assert.ok(first.validation.length >= 1);
  assert.ok(first.test.length >= 1);
  assert.ok(first.train.length > first.validation.length);
});

test("gravação e exportação chat preservam o protocolo do agente", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "m5-security-tune-"));
  const dataDir = path.join(root, "security-tune");
  const chatDir = path.join(root, "finetune");

  const samples = generateSecurityTuneSamples();
  const manifest = writeSecurityTuneDataset(dataDir, samples);
  assert.equal(manifest.total, samples.length);
  assert.equal(fs.existsSync(path.join(dataDir, "manifest.json")), true);
  assert.equal(fs.existsSync(path.join(dataDir, "own", "security", "train.jsonl")), true);

  const chat = toChatSample(samples[0]);
  assert.equal(chat.messages[0].role, "system");
  assert.equal(chat.messages[0].content, SECURITY_SYSTEM_PROMPT);
  assert.equal(chat.messages[1].role, "user");
  assert.equal(chat.messages[2].role, "assistant");
  assert.match(SECURITY_SYSTEM_PROMPT, /<tool name=/);
  assert.match(SECURITY_SYSTEM_PROMPT, /<final>/);

  const exportManifest = exportFinetuneDataset(dataDir, chatDir);
  assert.equal(exportManifest.total, samples.length);
  assert.equal(exportManifest.format, "chat-jsonl");
  assert.equal(exportManifest.safety.noWeaponizedContent, true);

  const line = fs
    .readFileSync(path.join(chatDir, "train.jsonl"), "utf8")
    .split(/\r?\n/)
    .find(Boolean);
  assert.ok(line);
  const parsed = JSON.parse(line!) as { messages: Array<{ role: string; content: string }> };
  assert.equal(parsed.messages.length, 3);
  assert.equal(parsed.messages[2].role, "assistant");
  assert.doesNotMatch(JSON.stringify(parsed), UNSAFE);
});
