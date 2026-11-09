/**
 * Testes offline do pipeline de conhecimento.
 * Nenhuma chamada de rede é feita aqui.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { EdbRecord } from "../src/knowledge/types";
import { mergeCves, normalizeCve } from "../src/knowledge/cve";
import {
  edbUrl,
  parseExploitDbCsv,
  parseExploitDbJson,
  searchEdb,
} from "../src/knowledge/exploitdb";
import {
  UNSAFE_TERMS,
  buildKnowledgeSamples,
  splitSamples,
  writeKnowledgeDataset,
} from "../src/knowledge/build";
import { SEED_CWE_DESCRIPTIONS, seedCves } from "../src/knowledge/seed";

const NVD_FIXTURE = {
  resultsPerPage: 1,
  startIndex: 0,
  totalResults: 1,
  vulnerabilities: [
    {
      cve: {
        id: "CVE-2099-0001",
        sourceIdentifier: "nvd@nist.gov",
        published: "2099-01-01T00:00:00.000",
        lastModified: "2099-01-02T00:00:00.000",
        descriptions: [
          {
            lang: "en",
            value:
              "Example vulnerability in Acme Server allows remote attackers to bypass authentication and access protected resources.",
          },
        ],
        metrics: {
          cvssMetricV31: [
            {
              source: "nvd@nist.gov",
              type: "Primary",
              cvssData: {
                version: "3.1",
                vectorString: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H",
                baseScore: 9.8,
                baseSeverity: "CRITICAL",
              },
              baseSeverity: "CRITICAL",
            },
          ],
        },
        weaknesses: [
          {
            source: "nvd@nist.gov",
            type: "Primary",
            description: [{ lang: "en", value: "CWE-287" }],
          },
        ],
        configurations: [
          {
            nodes: [
              {
                operator: "OR",
                cpeMatch: [
                  {
                    vulnerable: true,
                    criteria: "cpe:2.3:a:acme:server:1.1:*:*:*:*:*:*:*",
                  },
                  {
                    vulnerable: true,
                    criteria: "cpe:2.3:a:acme:server:1.0:*:*:*:*:*:*:*",
                  },
                ],
              },
            ],
          },
        ],
        references: [
          { url: "https://example.test/advisory", tags: ["Vendor Advisory"] },
          { url: "https://example.test/advisory", tags: ["Patch"] },
        ],
      },
    },
  ],
};

const CSV_FIXTURE = [
  "id,file,description,date_published,author,type,platform,codes,source,tags",
  '12345,exploits/linux/local/12345.c,"Example, quoted description",2024-01-01,Researcher,local,Linux,"CVE-2024-1111;CVE-2024-2222",exploitdb,local',
  "67890,exploits/windows/remote/67890.py,Another metadata row,2024-02-02,Researcher,remote,Windows,CVE-2024-3333,exploitdb,remote",
].join("\n");

const EDB_FIXTURE: EdbRecord[] = [
  {
    id: "12345",
    file: "exploits/linux/local/12345.c",
    description: "Example local privilege issue in a cataloged Linux service.",
    datePublished: "2024-01-01",
    author: "Researcher",
    type: "local",
    platform: "Linux",
    cveCodes: ["CVE-2024-1111"],
    url: edbUrl("12345"),
  },
];

test("normalizeCve extrai CVSS, CWE, CPE e referências do formato NVD 2.0", () => {
  const record = normalizeCve(NVD_FIXTURE.vulnerabilities[0]);

  assert.equal(record.id, "CVE-2099-0001");
  assert.equal(record.source, "nvd@nist.gov");
  assert.equal(record.published, "2099-01-01T00:00:00.000");
  assert.match(record.description, /bypass authentication/);
  assert.deepEqual(record.cvss, {
    version: "3.1",
    score: 9.8,
    severity: "CRITICAL",
    vector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H",
  });
  assert.deepEqual(record.cwes, ["CWE-287"]);
  assert.deepEqual(record.weaknesses, ["CWE-287"]);
  assert.deepEqual(record.products, [
    { vendor: "acme", product: "server", versions: ["1.0", "1.1"] },
  ]);
  assert.equal(record.references.length, 1);
  assert.deepEqual(record.references[0].tags.sort(), ["Patch", "Vendor Advisory"]);
});

test("mergeCves deduplica por id e mantém a versão mais recente", () => {
  const [base] = seedCves();
  const older = { ...base, modified: "2020-01-01", description: "versão antiga" };
  const newer = {
    ...base,
    modified: "2024-01-01",
    description: "versão nova",
    cwes: [...base.cwes, "CWE-20"],
  };

  const merged = mergeCves([older, newer]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].description, "versão nova");
  assert.ok(merged[0].cwes.includes("CWE-20"));
});

test("parseExploitDbCsv lê o CSV oficial sem baixar o campo file", () => {
  const records = parseExploitDbCsv(CSV_FIXTURE);

  assert.equal(records.length, 2);
  assert.equal(records[0].id, "12345");
  assert.equal(records[0].file, "exploits/linux/local/12345.c");
  assert.equal(records[0].description, "Example, quoted description");
  assert.deepEqual(records[0].cveCodes, ["CVE-2024-1111", "CVE-2024-2222"]);
  assert.equal(records[0].url, "https://www.exploit-db.com/exploits/12345");
  assert.equal(records[1].platform, "Windows");
  assert.deepEqual(records[1].cveCodes, ["CVE-2024-3333"]);
});

test("parseExploitDbJson e searchEdb operam apenas sobre metadados", () => {
  const json = JSON.stringify({
    data: [
      {
        id: 777,
        file: "exploits/multiple/remote/777.py",
        description: "Cataloged web application issue",
        date_published: "2024-03-03",
        author: "Researcher",
        type: "remote",
        platform: "Multiple",
        codes: "CVE-2024-4444",
      },
    ],
  });

  const records = parseExploitDbJson(json);
  assert.equal(records.length, 1);
  assert.equal(records[0].id, "777");
  assert.equal(records[0].url, "https://www.exploit-db.com/exploits/777");
  assert.deepEqual(records[0].cveCodes, ["CVE-2024-4444"]);

  assert.equal(searchEdb(records, { cve: "cve-2024-4444" }).length, 1);
  assert.equal(searchEdb(records, { platform: "multiple" }).length, 1);
  assert.equal(searchEdb(records, { q: "web application" }).length, 1);
  assert.equal(searchEdb(records, { cve: "CVE-2024-9999" }).length, 0);
});

test("buildKnowledgeSamples gera 5 tarefas por CVE e deduplica", () => {
  const [cve] = seedCves();
  const samples = buildKnowledgeSamples({
    cves: [cve, { ...cve }],
    edb: [],
    cweDescriptions: SEED_CWE_DESCRIPTIONS,
  });

  assert.equal(samples.length, 5);
  const instructions = new Set(samples.map((sample) => sample.instruction));
  assert.equal(instructions.size, 5);
  const tasks = samples.map((sample) => String(sample.meta.task)).sort();
  assert.deepEqual(tasks, ["cvss", "cwe", "detection", "explain", "mitigation"]);
  assert.ok(samples.every((sample) => sample.meta.defensive === true));
  assert.ok(samples.every((sample) => sample.output.length > 0));
});

test("buildKnowledgeSamples gera 2 tarefas por registro do ExploitDB", () => {
  const samples = buildKnowledgeSamples({
    cves: [],
    edb: EDB_FIXTURE,
    cweDescriptions: SEED_CWE_DESCRIPTIONS,
  });

  assert.equal(samples.length, 2);
  assert.deepEqual(
    samples.map((sample) => sample.meta.task).sort(),
    ["edb-detection", "edb-summary"],
  );
  assert.ok(samples.every((sample) => sample.meta.source === "exploitdb"));
});

test("splits somam 100% e são determinísticos", () => {
  const samples = buildKnowledgeSamples({
    cves: seedCves(),
    edb: EDB_FIXTURE,
    cweDescriptions: SEED_CWE_DESCRIPTIONS,
  });
  const splits = splitSamples(samples);
  const total = splits.train.length + splits.validation.length + splits.test.length;

  assert.equal(total, samples.length);
  assert.ok(splits.validation.length >= 1);
  assert.ok(splits.test.length >= 1);
  assert.ok(splits.train.length > splits.validation.length);
  const ratio = splits.train.length / total;
  assert.ok(ratio >= 0.85 && ratio <= 0.95);

  const again = splitSamples(samples);
  assert.deepEqual(
    again.train.map((sample) => sample.instruction),
    splits.train.map((sample) => sample.instruction),
  );
});

test("writeKnowledgeDataset grava JSONL, manifest e contagens consistentes", () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "m5-knowledge-"));
  try {
    const samples = buildKnowledgeSamples({
      cves: seedCves(),
      edb: EDB_FIXTURE,
      cweDescriptions: SEED_CWE_DESCRIPTIONS,
    });
    const manifest = writeKnowledgeDataset(samples, outDir);

    assert.equal(manifest.total, samples.length);
    assert.equal(
      manifest.splits.train + manifest.splits.validation + manifest.splits.test,
      samples.length,
    );
    assert.ok(fs.existsSync(path.join(outDir, "manifest.json")));

    for (const split of ["train", "validation", "test"] as const) {
      const text = fs.readFileSync(path.join(outDir, `${split}.jsonl`), "utf8").trim();
      const lines = text ? text.split(/\r?\n/) : [];
      assert.equal(lines.length, manifest.splits[split]);
      for (const line of lines) {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        assert.equal(typeof parsed.instruction, "string");
        assert.equal(typeof parsed.output, "string");
      }
    }
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("seed tem pelo menos 20 CVEs reais, únicos e com CVSS/CWE/mitigação", () => {
  const records = seedCves();
  assert.ok(records.length >= 20);

  const ids = new Set(records.map((record) => record.id));
  assert.equal(ids.size, records.length);

  for (const record of records) {
    assert.match(record.id, /^CVE-\d{4}-\d{4,}$/);
    assert.ok(record.description.length > 20);
    assert.ok(record.cvss);
    assert.ok(record.cvss!.score >= 0 && record.cvss!.score <= 10);
    assert.ok(record.cwes.length > 0);
    assert.ok(record.products.length > 0);
    assert.ok(record.mitigation && record.mitigation.length > 20);
  }

  assert.ok(ids.has("CVE-2021-44228"));
  assert.ok(ids.has("CVE-2014-0160"));
  assert.ok(ids.has("CVE-2017-0144"));
});

test("nenhuma amostra gerada contém termos de payload/exploração", () => {
  const samples = buildKnowledgeSamples({
    cves: seedCves(),
    edb: EDB_FIXTURE,
    cweDescriptions: SEED_CWE_DESCRIPTIONS,
  });
  const payload = JSON.stringify(samples).toLowerCase();

  for (const term of UNSAFE_TERMS) {
    assert.equal(
      payload.includes(term.toLowerCase()),
      false,
      `termo ofensivo encontrado: ${term}`,
    );
  }
});
