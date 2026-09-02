/**
 * Compile-fail tests for janela's typed IPC contract.
 *
 * janela's central claim is that a page checked against a host's contract
 * cannot call an undeclared command, pass wrong arguments, misuse a result or
 * subscribe to an event that does not exist — with no code generation, because
 * both sides are TypeScript and the frontend imports the host's own types.
 *
 * That claim is only worth anything if it is enforced, and "does it compile"
 * is not enough to prove it: a contract that silently degraded to `any` would
 * pass a naive check. So each fixture declares the diagnostic it must produce,
 * by code AND by message, and the runner fails if the expected error is
 * missing, if a different error appears, or if a fixture that must be clean is
 * not.
 *
 * Fixtures are checked through the package's own exports map — they import
 * "janela/host" and "janela/api" exactly as a project does — so a broken
 * exports map fails here too.
 *
 * Annotations, at the top of a fixture:
 *   // @expect TS2345 <substring of the message>
 *   // @expect-ok
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures");

/** Fixture expectations, read from the `@expect` header comments. */
function expectationsFor(file) {
  const out = [];
  let ok = false;
  for (const line of readFileSync(join(FIXTURES, file), "utf8").split("\n")) {
    if (!line.startsWith("//")) break;               // header comment only
    const m = /^\/\/\s*@expect\s+TS(\d+)\s+(.*)$/.exec(line.trim());
    if (m) out.push({ code: Number(m[1]), text: m[2].trim() });
    else if (/^\/\/\s*@expect-ok\s*$/.test(line.trim())) ok = true;
  }
  return { expects: out, ok };
}

const config = ts.readConfigFile(join(HERE, "tsconfig.json"), ts.sys.readFile);
if (config.error) {
  console.error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  process.exit(1);
}
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, HERE);

const program = ts.createProgram(parsed.fileNames, parsed.options);
// One program for every fixture: tsc reports all files, so an error in one
// does not hide the others, and the whole suite costs a single check.
const all = [...program.getSemanticDiagnostics(), ...program.getSyntacticDiagnostics()];

/** basename → diagnostics */
const byFile = new Map();
for (const d of all) {
  if (!d.file) continue;
  const name = d.file.fileName.split("/").pop();
  if (!byFile.has(name)) byFile.set(name, []);
  byFile.get(name).push({
    code: d.code,
    text: ts.flattenDiagnosticMessageText(d.messageText, " "),
    line: d.file.getLineAndCharacterOfPosition(d.start ?? 0).line + 1,
  });
}

const fixtures = readdirSync(FIXTURES).filter((f) => f.endsWith(".ts") && f !== "contract.ts");
let failed = 0;
const lines = [];

for (const file of fixtures.sort()) {
  const { expects, ok } = expectationsFor(file);
  const got = byFile.get(file) ?? [];

  if (!ok && expects.length === 0) {
    lines.push(`  ?  ${file} — no @expect or @expect-ok annotation`);
    failed++;
    continue;
  }

  if (ok) {
    if (got.length === 0) {
      lines.push(`  ok ${file} — clean, as required`);
    } else {
      failed++;
      lines.push(`  FAIL ${file} — must type-check clean, but got:`);
      for (const d of got) lines.push(`       ${file}:${d.line} TS${d.code}: ${d.text}`);
    }
    continue;
  }

  // A failing fixture: every expectation must be met, and nothing else raised.
  const unmatched = [...got];
  const missing = [];
  for (const e of expects) {
    const i = unmatched.findIndex((d) => d.code === e.code && d.text.includes(e.text));
    if (i === -1) missing.push(e);
    else unmatched.splice(i, 1);
  }

  if (missing.length === 0 && unmatched.length === 0) {
    lines.push(`  ok ${file} — TS${expects.map((e) => e.code).join(", TS")} as expected`);
  } else {
    failed++;
    lines.push(`  FAIL ${file}`);
    for (const e of missing) {
      lines.push(`       expected TS${e.code} containing: ${e.text}`);
      lines.push(
        got.length
          ? `       but the errors were: ${got.map((d) => `TS${d.code}: ${d.text}`).join(" | ")}`
          : `       but it compiled with no errors — the contract is not being enforced`,
      );
    }
    for (const d of unmatched) {
      lines.push(`       unexpected ${file}:${d.line} TS${d.code}: ${d.text}`);
    }
  }
}

console.log(`typed contract: ${fixtures.length} fixtures`);
console.log(lines.join("\n"));
if (failed) {
  console.error(`\n${failed} of ${fixtures.length} fixtures failed`);
  process.exit(1);
}
console.log(`\nall ${fixtures.length} fixtures behaved as declared`);
