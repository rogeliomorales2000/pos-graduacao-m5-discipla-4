import { strict as assert } from "node:assert";
import test from "node:test";
import {
  checkPythonSyntax,
  extractTaskRequirements,
  validateGeneratedContent,
} from "../src/core/requirements";

const TASK =
  "adicionar ao arquivo como subir PTY em SSH FTP em SOCKET, "
  + "adicionar tambem leitura de buffer dinamico e percorrer a memoria "
  + "mapeando offsets durante a execucao";

test("extrai requisitos técnicos explícitos da tarefa", () => {
  const keys = extractTaskRequirements(TASK).map((rule) => rule.key);
  for (const key of ["pty", "ssh", "ftp", "socket", "buffer", "offset", "memory"]) {
    assert.ok(keys.includes(key), `requisito ausente: ${key}`);
  }
});

test("rejeita stub que só abre socket e não cobre os requisitos", () => {
  const stub = [
    "import socket",
    "import sys",
    "",
    "def main():",
    "    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)",
    "    sock.connect((sys.argv[1], 22))  # SSH",
    "    sock.close()",
    "",
    "if __name__ == \"__main__\":",
    "    main()",
    "",
  ].join("\n");

  const issue = validateGeneratedContent(TASK, "teste.py", stub);
  assert.ok(issue);
  assert.ok(issue.missing.includes("ssh"));
  assert.ok(issue.missing.includes("pty"));
  assert.ok(issue.missing.includes("ftp"));
  assert.equal(issue.tooThin, true);
});

test("aceita implementação Python completa dos requisitos", () => {
  const filler = Array.from(
    { length: 24 },
    (_, index) => `def helper_${index}():\n    return ${index}\n`,
  ).join("\n");
  const good = [
    "import socket",
    "from ftplib import FTP",
    "",
    "class PtySession:",
    "    def open_pty(self):",
    "        return \"pty\"",
    "",
    "class SshClient:",
    "    def ssh_connect(self):",
    "        return \"ssh\"",
    "",
    "class SocketClient:",
    "    def socket_connect(self):",
    "        return socket.socket(socket.AF_INET, socket.SOCK_STREAM)",
    "",
    "class DynamicBuffer:",
    "    def __init__(self):",
    "        self.data = bytearray()",
    "        self.offset = 0",
    "",
    "    def feed(self, chunk: bytes) -> None:",
    "        self.data.extend(chunk)",
    "",
    "    def read(self, size: int) -> bytes:",
    "        chunk = bytes(self.data[self.offset:self.offset + size])",
    "        self.offset += len(chunk)",
    "        return chunk",
    "",
    "def ftp_client(host: str) -> FTP:",
    "    return FTP(host)",
    "",
    filler,
    "if __name__ == \"__main__\":",
    "    print(PtySession().open_pty())",
    "",
  ].join("\n");

  assert.equal(validateGeneratedContent(TASK, "teste.py", good), null);
});

test("comentário com nome do requisito não conta como implementação", () => {
  const commented = "import socket\n# SSH PTY FTP buffer offset\ndef main():\n    return socket\n";
  const issue = validateGeneratedContent(TASK, "teste.py", commented);
  assert.ok(issue);
  assert.ok(issue.missing.includes("ssh"));
  assert.ok(issue.missing.includes("pty"));
});

test("não aplica requisitos de código a documentação", () => {
  assert.equal(validateGeneratedContent(TASK, "README.md", "texto simples"), null);
});

test("não bloqueia tarefa de remoção por não conter o recurso removido", () => {
  const removal = "remova suporte a SSH e FTP do arquivo";
  assert.equal(validateGeneratedContent(removal, "teste.py", "import socket\n"), null);
});

test("detecta sintaxe Python inválida quando o interpretador está disponível", (t) => {
  const bad = "if __name__ \"==\" \"__main__\":\n    pass\n";
  const check = checkPythonSyntax(bad);
  if (!check.available) {
    t.skip("python indisponível");
    return;
  }
  assert.ok(check.error);
  const issue = validateGeneratedContent("crie teste.py", "teste.py", bad);
  assert.ok(issue);
  assert.match(issue.message, /Python inválido/);
});
