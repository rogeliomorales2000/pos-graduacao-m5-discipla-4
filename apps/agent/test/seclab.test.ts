import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertInScope,
  createAuthorization,
  isActive,
  isExpired,
  loadAuthorization,
  parseScopeTarget,
  saveAuthorization,
  validateAuthorization,
} from "../src/modules/seclab/scope";
import { appendAudit, readAudit, verifyChain } from "../src/modules/seclab/audit";
import {
  generateOverflowLab,
  mitigationsTable,
  payloadPlan,
} from "../src/modules/seclab/overflow";
import {
  cvss31,
  parseVector,
  roundup,
  scoreVector,
  severity,
} from "../src/modules/seclab/cvss";
import { buildReconChecklist, toolAvailability } from "../src/modules/seclab/recon";
import { generateReport } from "../src/modules/seclab/report";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "m5-seclab-"));
}

function authFor(target = "host:127.0.0.1", days = 2) {
  return createAuthorization({
    authorizedBy: "Equipe de segurança",
    authorizationRef: "AUTH-TEST-001",
    targets: [target],
    days,
  });
}

test("CVSS 3.1: vetores conhecidos", () => {
  assert.equal(
    cvss31(parseVector("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H")),
    9.8,
  );
  assert.equal(
    cvss31(parseVector("CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N")),
    6.1,
  );
  assert.equal(
    cvss31(parseVector("CVSS:3.1/AV:L/AC:H/PR:H/UI:R/S:U/C:L/I:N/A:N")),
    1.8,
  );
  assert.equal(scoreVector("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"), 9.8);
  assert.equal(severity(9.8), "Critical");
  assert.equal(severity(6.1), "Medium");
  assert.equal(severity(0), "None");
});

test("CVSS 3.1: Roundup oficial e validação de vetor", () => {
  assert.equal(roundup(4.0), 4.0);
  assert.equal(roundup(4.02), 4.1);
  assert.equal(roundup(4.000000001), 4.0);
  assert.equal(roundup(9.800000001), 9.8);

  assert.throws(() => parseVector("CVSS:3.0/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"));
  assert.throws(() => parseVector("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H"));
  assert.throws(() => parseVector("CVSS:3.1/AV:X/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"));
});

test("auditoria: cadeia válida e detecção de adulteração", () => {
  const dir = tempDir();
  const file = path.join(dir, "audit.jsonl");

  assert.deepEqual(verifyChain(file), { valid: true, entries: 0 });
  appendAudit(file, { action: "scope.created", id: "a1" }, { ts: "2026-01-01T00:00:00.000Z" });
  appendAudit(file, { action: "recon.checklist", target: "127.0.0.1" }, { ts: "2026-01-01T00:01:00.000Z" });
  appendAudit(file, { action: "report.generated" }, { ts: "2026-01-01T00:02:00.000Z" });

  const entries = readAudit(file);
  assert.equal(entries.length, 3);
  assert.equal(entries[0].seq, 1);
  assert.equal(entries[1].prevHash, entries[0].hash);
  assert.equal(entries[2].seq, 3);
  assert.deepEqual(verifyChain(file), { valid: true, entries: 3 });

  // Adultera o segundo evento mantendo o hash antigo.
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
  const second = JSON.parse(lines[1]) as { event: Record<string, unknown> };
  second.event.target = "10.0.0.1";
  lines[1] = JSON.stringify(second);
  fs.writeFileSync(file, `${lines.join("\n")}\n`, "utf8");

  const result = verifyChain(file);
  assert.equal(result.valid, false);
  assert.equal(result.brokenAt, 2);
  assert.match(String(result.reason), /hash|adulterad/i);
});

test("escopo: autorização válida, load/save e expiração", () => {
  const dir = tempDir();
  const file = path.join(dir, "authorization.json");
  const auth = authFor("host:127.0.0.1", 2);

  assert.equal(validateAuthorization(auth).valid, true);
  assert.equal(isExpired(auth), false);
  assert.equal(isActive(auth), true);
  saveAuthorization(file, auth);
  assert.deepEqual(loadAuthorization(file), auth);
  assert.equal(assertInScope(auth, "127.0.0.1").value, "127.0.0.1");
  assert.equal(assertInScope(auth, "http://127.0.0.1:8080/painel").value, "127.0.0.1");

  const expired = createAuthorization({
    authorizedBy: "Equipe de segurança",
    authorizationRef: "AUTH-EXPIRED",
    targets: ["host:127.0.0.1"],
    startsAt: "2020-01-01T00:00:00.000Z",
    expiresAt: "2020-01-02T00:00:00.000Z",
  });
  assert.equal(isExpired(expired), true);
  assert.throws(() => assertInScope(expired, "127.0.0.1"), /expirada/i);

  const invalid = { ...auth, authorizedBy: "" };
  assert.equal(validateAuthorization(invalid).valid, false);
});

test("escopo: CIDR, sub-rede, wildcard e device", () => {
  const cidr = createAuthorization({
    authorizedBy: "Equipe",
    authorizationRef: "AUTH-CIDR",
    targets: ["cidr:10.20.0.0/24"],
    days: 1,
  });
  assert.ok(assertInScope(cidr, "10.20.0.42"));
  assert.ok(assertInScope(cidr, "http://10.20.0.42:8080/painel"));
  assert.throws(() => assertInScope(cidr, "10.20.1.42"), /fora do escopo/i);

  const network = createAuthorization({
    authorizedBy: "Equipe",
    authorizationRef: "AUTH-NET",
    targets: ["cidr:10.0.0.0/16"],
    days: 1,
  });
  assert.ok(assertInScope(network, "10.0.5.0/24"));
  assert.throws(() => assertInScope(network, "10.1.0.0/24"), /fora do escopo/i);

  const wildcard = createAuthorization({
    authorizedBy: "Equipe",
    authorizationRef: "AUTH-WILD",
    targets: ["host:*.example.test"],
    days: 1,
  });
  assert.ok(assertInScope(wildcard, "api.example.test"));
  assert.throws(() => assertInScope(wildcard, "example.test"), /fora do escopo/i);

  const device = createAuthorization({
    authorizedBy: "Equipe",
    authorizationRef: "AUTH-DEV",
    targets: ["device:emulator-5554"],
    days: 1,
  });
  assert.ok(assertInScope(device, "emulator-5554"));

  assert.deepEqual(parseScopeTarget("url:https://example.test/app"), {
    kind: "url",
    value: "https://example.test/app",
  });
});

test("overflow: geração do laboratório e plano de offset", () => {
  const lab = generateOverflowLab({ bufferSize: 64, canary: true, nx: true, pie: true });
  assert.match(lab.files["vulnerable.c"], /#define LAB_BUFFER_SIZE 64/);
  assert.match(lab.files["vulnerable.c"], /strcpy\(buffer, input\)/);
  assert.match(lab.files["mitigated.c"], /memcpy\(buffer, input, len \+ 1\)/);
  assert.match(lab.compile.gccWsl.vulnerable, /-fno-stack-protector/);
  assert.doesNotMatch(lab.compile.gccWsl.mitigated, /-fno-stack-protector/);
  assert.match(lab.compile.gccWsl.mitigated, /-fstack-protector-strong/);
  assert.match(lab.compile.gccWsl.mitigated, /-fPIE/);
  assert.equal(lab.commands.gccWsl.length, 2);
  assert.equal(lab.commands.msvc.length, 2);
  assert.equal(lab.compile.gccWsl.vulnerable, lab.compile.gcc[0]);
  assert.equal(lab.compile.msvc.length, 2);
  assert.match(lab.compile.msvc.mitigated, /\/GS/);
  assert.equal(lab.gdb, lab.gdbScript);
  assert.match(lab.gdbScript, /break inspect/);
  assert.ok(lab.notes.length > 0);
  assert.doesNotMatch(lab.files["vulnerable.c"], /\\x90|endereço de retorno concreto [0-9a-f]/i);

  assert.equal(mitigationsTable().length, 6);
  assert.deepEqual(
    mitigationsTable().map((row) => row.name),
    ["ASLR", "NX", "Stack Canary", "PIE", "RELRO", "FORTIFY_SOURCE"],
  );
  assert.ok(mitigationsTable().every((row) => row.howToCheck.includes("checksec") || row.howToCheck.length > 0));

  const plan = payloadPlan({ bufferSize: 64, savedRbp: 8, alignment: 0 });
  assert.equal(plan.offsetToReturnAddress, 72);
  assert.equal(plan.valid, true);

  const padded = payloadPlan({ bufferSize: 32, savedRbp: 8, alignment: 8 });
  assert.equal(padded.offsetToReturnAddress, 48);
  assert.equal(padded.valid, true);

  const negative = payloadPlan({ bufferSize: -1, savedRbp: 8, alignment: 0 });
  assert.equal(negative.valid, false);
  assert.ok(negative.errors.length > 0);
});

test("recon: exige escopo vigente e entrega comandos com explicação", () => {
  const auth = authFor("host:127.0.0.1", 1);
  const checklist = buildReconChecklist(auth, "127.0.0.1", "host");
  assert.equal(checklist.kind, "host");
  assert.ok(checklist.items.length >= 3);
  assert.ok(checklist.items.every((item) => item.command.length > 0 && item.reveals.length > 0));
  assert.ok(checklist.items.some((item) => item.command.startsWith("nmap")));
  assert.ok(checklist.warnings.length > 0);

  const web = buildReconChecklist(auth, "127.0.0.1", "web");
  assert.equal(web.kind, "web");
  assert.ok(web.items.some((item) => item.command.includes("curl")));

  assert.throws(() => buildReconChecklist(auth, "192.168.99.10", "host"), /fora do escopo/i);

  const expired = createAuthorization({
    authorizedBy: "Equipe",
    authorizationRef: "AUTH-OLD",
    targets: ["host:127.0.0.1"],
    startsAt: "2020-01-01T00:00:00.000Z",
    expiresAt: "2020-01-02T00:00:00.000Z",
  });
  assert.throws(() => buildReconChecklist(expired, "127.0.0.1", "host"), /expirada/i);

  const tools = toolAvailability();
  assert.deepEqual(Object.keys(tools).sort(), ["curl", "git", "nmap", "openssl"]);
  assert.ok(Object.values(tools).every((value) => typeof value === "boolean"));
});

test("relatório: contém sumário, tabela e apêndice", () => {
  const markdown = generateReport([
    {
      title: "Cabeçalho de segurança ausente",
      asset: "https://app.example.test",
      severity: "Medium",
      cvss: 5.3,
      evidence: ["GET / => HTTP/1.1 200", "sem Strict-Transport-Security"],
      impact: "Facilita downgrade e clickjacking em redes hostis.",
      remediation: "Adicionar HSTS, CSP e X-Frame-Options compatíveis com o app.",
      refs: ["AUTH-TEST-001", "OWASP Secure Headers"],
    },
    {
      title: "TLS 1.0 habilitado",
      asset: "app.example.test:443",
      severity: "High",
      cvss: 7.4,
      evidence: "openssl s_client negociou TLSv1",
      impact: "Algoritmos obsoletos reduzem a proteção do canal.",
      remediation: "Desabilitar TLS 1.0/1.1 e revisar a suíte de cifras.",
    },
  ]);

  assert.match(markdown, /# Relatório de Segurança/);
  assert.match(markdown, /## Sumário Executivo/);
  assert.match(markdown, /## Tabela de Achados/);
  assert.match(markdown, /## Detalhes dos Achados/);
  assert.match(markdown, /## Apêndice de Evidências/);
  assert.match(markdown, /Cabeçalho de segurança ausente/);
  assert.match(markdown, /TLS 1\.0 habilitado/);
  assert.match(markdown, /5\.3/);
  assert.match(markdown, /AUTH-TEST-001/);
  assert.match(markdown, /Strict-Transport-Security/);
});
