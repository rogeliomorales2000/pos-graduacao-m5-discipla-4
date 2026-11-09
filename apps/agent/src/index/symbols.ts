/**
 * Extração de símbolos.
 *
 * TypeScript/JavaScript usa a Compiler API (sem precisar de tsconfig, pois
 * criamos um `SourceFile` isolado). As demais linguagens usam regex por linha,
 * que é "burro" mas robusto: nunca lança e cobre os padrões mais comuns.
 */

import ts from "typescript";
import type { SymbolInfo, SymbolKind } from "./types";

const MAX_SYMBOLS_PER_FILE = 800;
const MAX_NAME = 120;
const MAX_SIGNATURE = 160;

/** Normaliza espaços e trunca nomes/assinaturas. */
function clean(text: string, max: number): string {
  const value = text.replace(/\s+/g, " ").trim();
  return value.length > max ? value.slice(0, max - 1) + "…" : value;
}

/** Extrai símbolos de TS/JS via AST, percorrendo apenas o "esqueleto". */
function extractTsSymbols(
  file: string,
  lang: string,
  content: string,
): SymbolInfo[] {
  const scriptKind =
    lang === "tsx"
      ? ts.ScriptKind.TSX
      : lang === "jsx"
        ? ts.ScriptKind.JSX
        : lang === "js"
          ? ts.ScriptKind.JS
          : ts.ScriptKind.TS;

  const source = ts.createSourceFile(
    file,
    content,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );
  const lines = content.split(/\r?\n/);
  const out: SymbolInfo[] = [];
  const seen = new Set<string>();

  const push = (rawName: string, kind: SymbolKind, node: ts.Node): void => {
    const name = clean(rawName, MAX_NAME);
    if (!name) return;
    const pos = source.getLineAndCharacterOfPosition(node.getStart(source));
    const line = pos.line + 1;
    const key = `${kind}:${name}:${line}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      name,
      kind,
      file,
      line,
      signature: clean(lines[line - 1] ?? "", MAX_SIGNATURE),
    });
  };

  const visitStatement = (node: ts.Node): void => {
    if (out.length >= MAX_SYMBOLS_PER_FILE) return;

    if (ts.isFunctionDeclaration(node)) {
      push(node.name?.text ?? "default", "function", node);
      return;
    }

    if (ts.isClassDeclaration(node)) {
      push(node.name?.text ?? "(anonymous)", "class", node);
      for (const member of node.members) {
        if (
          ts.isMethodDeclaration(member) ||
          ts.isGetAccessor(member) ||
          ts.isSetAccessor(member)
        ) {
          if (member.name) push(member.name.getText(source), "method", member);
        } else if (ts.isConstructorDeclaration(member)) {
          push("constructor", "method", member);
        } else if (ts.isPropertyDeclaration(member) && member.name) {
          push(member.name.getText(source), "variable", member);
        }
      }
      return;
    }

    if (ts.isInterfaceDeclaration(node)) {
      push(node.name.text, "interface", node);
      for (const member of node.members) {
        if (!member.name) continue;
        if (ts.isMethodSignature(member)) {
          push(member.name.getText(source), "method", member);
        } else if (ts.isPropertySignature(member)) {
          push(member.name.getText(source), "variable", member);
        }
      }
      return;
    }

    if (ts.isTypeAliasDeclaration(node)) {
      push(node.name.text, "type", node);
      return;
    }

    if (ts.isEnumDeclaration(node)) {
      push(node.name.text, "enum", node);
      return;
    }

    if (ts.isModuleDeclaration(node)) {
      push(node.name.getText(source), "module", node);
      if (node.body && ts.isModuleBlock(node.body)) {
        for (const stmt of node.body.statements) visitStatement(stmt);
      }
      return;
    }

    if (ts.isVariableStatement(node)) {
      const isConst = (node.declarationList.flags & ts.NodeFlags.Const) !== 0;
      for (const decl of node.declarationList.declarations) {
        push(decl.name.getText(source), isConst ? "const" : "variable", decl);
      }
    }
  };

  for (const statement of source.statements) visitStatement(statement);
  return out;
}

const C_KEYWORDS = new Set([
  "if",
  "else",
  "for",
  "while",
  "switch",
  "case",
  "return",
  "sizeof",
  "typedef",
  "struct",
  "union",
  "enum",
  "class",
  "do",
  "goto",
  "new",
  "delete",
  "throw",
  "catch",
  "try",
]);

/** Regex de função C/C++ no início da linha (convenção de coluna 0). */
const C_FUNCTION_RE =
  /^(?:(?:static|inline|extern|const|unsigned|signed|struct|enum|union|void|char|short|int|long|float|double|bool|size_t|[A-Za-z_]\w*)[\s*]+)+([A-Za-z_]\w*(?:::\w+)*)\s*\([^;{}]*\)\s*(?:const|noexcept|override|final)?\s*\{?\s*$/;

const JAVA_METHOD_RE =
  /^(?:(?:public|private|protected|internal|static|final|abstract|synchronized|native|default|strictfp|override|virtual|async|sealed|new|unsafe|extern)\s+)*(?:[\w<>\[\],.?]+\s+)+([A-Za-z_]\w*)\s*\([^;]*\)\s*(?:throws\s+[\w,.\s]+)?\{?\s*$/;

const GO_FUNC_RE = /^func\s+\(([^)]*)\)\s*([A-Za-z_]\w*)/;
const GO_PLAIN_FUNC_RE = /^func\s+([A-Za-z_]\w*)/;

const RUST_FN_RE =
  /^(?:pub(?:\([^)]*\))?\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?fn\s+([A-Za-z_]\w*)/;

const PHP_FUNCTION_RE =
  /^(?:(?:public|private|protected|static|abstract|final)\s+)*function\s+&?\s*([A-Za-z_]\w*)/;

const SQL_RE =
  /^create\s+(?:or\s+replace\s+)?(table|view|index|function|procedure|trigger)\s+(?:if\s+not\s+exists\s+)?([`"\[\]\w.]+)/i;

/** Extrai símbolos de linguagens não-TS por varredura de linhas. */
function extractRegexSymbols(
  file: string,
  lang: string,
  content: string,
): SymbolInfo[] {
  const lines = content.split(/\r?\n/);
  const out: SymbolInfo[] = [];
  const seen = new Set<string>();

  const push = (rawName: string, kind: SymbolKind, line: number): void => {
    const name = clean(rawName, MAX_NAME);
    if (!name) return;
    const key = `${kind}:${name}:${line}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (out.length >= MAX_SYMBOLS_PER_FILE) return;
    out.push({
      name,
      kind,
      file,
      line,
      signature: clean(lines[line - 1] ?? "", MAX_SIGNATURE),
    });
  };

  // Contexto simples de classes Python/Rust/Java para classificar métodos.
  const pyClasses: Array<{ indent: number }> = [];
  let rustImplDepth = 0;
  let braceDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    if (out.length >= MAX_SYMBOLS_PER_FILE) break;
    const raw = lines[i] ?? "";
    if (!raw || raw.length > 500) {
      braceDepth += (raw.match(/\{/g) ?? []).length - (raw.match(/\}/g) ?? []).length;
      continue;
    }
    const line = raw.trim();
    if (
      !line ||
      line.startsWith("//") ||
      line.startsWith("/*") ||
      line.startsWith("*") ||
      line.startsWith("#!") ||
      (line.startsWith("#") && !line.startsWith("#define") && !line.startsWith("#include"))
    ) {
      braceDepth += (raw.match(/\{/g) ?? []).length - (raw.match(/\}/g) ?? []).length;
      continue;
    }

    const lineNo = i + 1;
    const indent = raw.length - raw.trimStart().length;

    if (lang === "py") {
      const classMatch = /^class\s+([A-Za-z_]\w*)/.exec(line);
      if (classMatch) {
        while (pyClasses.length > 0 && indent <= (pyClasses.at(-1)?.indent ?? -1)) {
          pyClasses.pop();
        }
        push(classMatch[1] ?? "", "class", lineNo);
        pyClasses.push({ indent });
        continue;
      }
      const defMatch = /^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/.exec(line);
      if (defMatch) {
        while (pyClasses.length > 0 && indent <= (pyClasses.at(-1)?.indent ?? -1)) {
          pyClasses.pop();
        }
        push(
          defMatch[1] ?? "",
          pyClasses.length > 0 ? "method" : "function",
          lineNo,
        );
        continue;
      }
      if (indent === 0 && !line.startsWith("@")) pyClasses.length = 0;
      continue;
    }

    if (lang === "c" || lang === "h" || lang === "cpp" || lang === "hpp") {
      const defineMatch = /^#\s*define\s+([A-Za-z_]\w*)/.exec(line);
      if (defineMatch) {
        push(defineMatch[1] ?? "", "const", lineNo);
        continue;
      }
      const structMatch = /^(?:typedef\s+)?struct\s+([A-Za-z_]\w*)/.exec(line);
      if (structMatch) {
        push(structMatch[1] ?? "", "struct", lineNo);
        continue;
      }
      const classMatch = /^class\s+([A-Za-z_]\w*)/.exec(line);
      if (classMatch) {
        push(classMatch[1] ?? "", "class", lineNo);
        continue;
      }
      const enumMatch = /^(?:typedef\s+)?(?:union|enum)\s+(?:class\s+)?([A-Za-z_]\w*)/.exec(line);
      if (enumMatch) {
        push(enumMatch[1] ?? "", "enum", lineNo);
        continue;
      }
      const typedefClose = /^}\s*([A-Za-z_]\w*)\s*;/.exec(line);
      if (typedefClose) {
        push(typedefClose[1] ?? "", "type", lineNo);
        continue;
      }
      if (indent === 0) {
        const funcMatch = C_FUNCTION_RE.exec(line);
        const name = funcMatch?.[1];
        if (name && !C_KEYWORDS.has(name)) push(name, "function", lineNo);
      }
      continue;
    }

    if (lang === "rs") {
      if (/^impl\b/.test(line)) {
        const implMatch = /^impl(?:<[^>]*>)?\s+(.+?)\s*(?:\{|where\b)/.exec(line);
        let target = implMatch?.[1] ?? "";
        const forIdx = target.lastIndexOf(" for ");
        if (forIdx >= 0) target = target.slice(forIdx + 5);
        target = target.replace(/<.*$/, "").split("::").pop() ?? "";
        push(target, "impl", lineNo);
        rustImplDepth = braceDepth + 1;
        braceDepth += (raw.match(/\{/g) ?? []).length - (raw.match(/\}/g) ?? []).length;
        continue;
      }
      const fnMatch = RUST_FN_RE.exec(line);
      if (fnMatch) {
        const inImpl = rustImplDepth > 0 && braceDepth >= rustImplDepth;
        push(fnMatch[1] ?? "", inImpl ? "method" : "function", lineNo);
      } else {
        const structMatch = /^(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_]\w*)/.exec(line);
        const enumMatch = /^(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_]\w*)/.exec(line);
        const traitMatch = /^(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_]\w*)/.exec(line);
        const modMatch = /^(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)/.exec(line);
        const typeMatch = /^(?:pub(?:\([^)]*\))?\s+)?type\s+([A-Za-z_]\w*)/.exec(line);
        const constMatch = /^(?:pub(?:\([^)]*\))?\s+)?(?:const|static)\s+([A-Za-z_]\w*)/.exec(line);
        if (structMatch) push(structMatch[1] ?? "", "struct", lineNo);
        else if (enumMatch) push(enumMatch[1] ?? "", "enum", lineNo);
        else if (traitMatch) push(traitMatch[1] ?? "", "trait", lineNo);
        else if (modMatch) push(modMatch[1] ?? "", "module", lineNo);
        else if (typeMatch) push(typeMatch[1] ?? "", "type", lineNo);
        else if (constMatch) push(constMatch[1] ?? "", "const", lineNo);
      }
      braceDepth += (raw.match(/\{/g) ?? []).length - (raw.match(/\}/g) ?? []).length;
      if (rustImplDepth > 0 && braceDepth < rustImplDepth) rustImplDepth = 0;
      continue;
    }

    if (lang === "go") {
      const methodMatch = GO_FUNC_RE.exec(line);
      if (methodMatch) {
        push(methodMatch[2] ?? "", "method", lineNo);
        continue;
      }
      const funcMatch = GO_PLAIN_FUNC_RE.exec(line);
      if (funcMatch) {
        push(funcMatch[1] ?? "", "function", lineNo);
        continue;
      }
      const structMatch = /^type\s+([A-Za-z_]\w*)\s+struct\b/.exec(line);
      if (structMatch) {
        push(structMatch[1] ?? "", "struct", lineNo);
        continue;
      }
      const ifaceMatch = /^type\s+([A-Za-z_]\w*)\s+interface\b/.exec(line);
      if (ifaceMatch) {
        push(ifaceMatch[1] ?? "", "interface", lineNo);
        continue;
      }
      const typeMatch = /^type\s+([A-Za-z_]\w*)/.exec(line);
      if (typeMatch) {
        push(typeMatch[1] ?? "", "type", lineNo);
        continue;
      }
      const constMatch = /^(?:const|var)\s+([A-Za-z_]\w*)/.exec(line);
      if (constMatch) push(constMatch[1] ?? "", "const", lineNo);
      continue;
    }

    if (lang === "java" || lang === "cs") {
      const classMatch = /^(?:(?:public|private|protected|internal|static|final|abstract|sealed|partial)\s+)*class\s+([A-Za-z_]\w*)/.exec(line);
      if (classMatch) {
        push(classMatch[1] ?? "", "class", lineNo);
        continue;
      }
      const ifaceMatch = /^(?:(?:public|private|protected|internal|static|final|abstract|sealed|partial)\s+)*interface\s+([A-Za-z_]\w*)/.exec(line);
      if (ifaceMatch) {
        push(ifaceMatch[1] ?? "", "interface", lineNo);
        continue;
      }
      const recordMatch = /^(?:(?:public|private|protected|internal|static|final|sealed|partial)\s+)*record\s+([A-Za-z_]\w*)/.exec(line);
      if (recordMatch) {
        push(recordMatch[1] ?? "", "struct", lineNo);
        continue;
      }
      const enumMatch = /^(?:(?:public|private|protected|internal|static|final|sealed)\s+)*enum\s+([A-Za-z_]\w*)/.exec(line);
      if (enumMatch) {
        push(enumMatch[1] ?? "", "enum", lineNo);
        continue;
      }
      if (indent > 0 && !line.startsWith("@") && !line.startsWith("return")) {
        const methodMatch = JAVA_METHOD_RE.exec(line);
        const name = methodMatch?.[1];
        if (name && !C_KEYWORDS.has(name)) push(name, "method", lineNo);
      }
      continue;
    }

    if (lang === "php") {
      const classMatch = /^(?:(?:abstract|final)\s+)?class\s+([A-Za-z_]\w*)/.exec(line);
      const ifaceMatch = /^(?:interface)\s+([A-Za-z_]\w*)/.exec(line);
      const traitMatch = /^(?:trait)\s+([A-Za-z_]\w*)/.exec(line);
      if (classMatch) {
        push(classMatch[1] ?? "", "class", lineNo);
        continue;
      }
      if (ifaceMatch) {
        push(ifaceMatch[1] ?? "", "interface", lineNo);
        continue;
      }
      if (traitMatch) {
        push(traitMatch[1] ?? "", "trait", lineNo);
        continue;
      }
      const funcMatch = PHP_FUNCTION_RE.exec(line);
      if (funcMatch) {
        push(funcMatch[1] ?? "", indent > 0 ? "method" : "function", lineNo);
      }
      continue;
    }

    if (lang === "sh" || lang === "ps1") {
      const fnMatch = /^(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\s*\)\s*\{?/.exec(line);
      const keywordMatch = /^function\s+([A-Za-z_][\w-]*)/.exec(line);
      if (keywordMatch) push(keywordMatch[1] ?? "", "function", lineNo);
      else if (fnMatch && fnMatch[1]) push(fnMatch[1], "function", lineNo);
      continue;
    }

    if (lang === "sql") {
      const match = SQL_RE.exec(line);
      if (match) {
        const object = (match[1] ?? "").toLowerCase();
        const kind: SymbolKind =
          object === "function" || object === "procedure" ? "function" : object === "table" || object === "view" ? "struct" : "module";
        push(match[2] ?? "", kind, lineNo);
      }
      continue;
    }

    if (lang === "md") {
      const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
      if (heading) push(heading[2] ?? "", "module", lineNo);
      continue;
    }
  }

  return out;
}

/**
 * Extrai símbolos de um arquivo. Nunca lança: em caso de conteúdo inválido
 * devolve o que conseguiu (ou lista vazia).
 */
export function extractSymbols(
  file: string,
  lang: string,
  content: string,
): SymbolInfo[] {
  if (!content.trim()) return [];
  try {
    if (lang === "ts" || lang === "tsx" || lang === "js" || lang === "jsx") {
      return extractTsSymbols(file, lang, content);
    }
    return extractRegexSymbols(file, lang, content);
  } catch {
    return [];
  }
}
