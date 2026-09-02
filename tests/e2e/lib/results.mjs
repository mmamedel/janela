// Parsing and bookkeeping for the battery's structured output.
//
// The one property that matters: a run passes only if EVERY expected
// assertion was seen. A page whose script throws still exits 0 and still
// prints "run returned 0", so absence — not a non-zero exit — is the signal
// that something broke. Several false green results on this project came from
// treating exit 0 as a pass.

const LINE = /JANELA_TEST (\{.*\})\s*$/;
const DONE = /JANELA_TEST_DONE (\[.*\])\s*$/;
const ERROR = /JANELA_TEST_ERROR (".*")\s*$/;
const LATE = /JANELA_TEST_LATE (.*)$/;

/** Every assertion the battery emits on every lane. */
export const CORE_ASSERTIONS = [
  "global-bridge",
  "sync-while-async-pending",
  "async-resolves-later",
  "sleep-due-order",
  "defer-next-turn",
  "async-reject",
  "emit-listen",
  "unlisten-stops",
  "fs-roundtrip",
  "fs-unicode",
  "fs-missing-error",
  "fs-directory-error",
  "large-read-correct",
  "large-read-bounded",
];

/** Emitted only where a framework actually renders (the Vite templates). */
export const FRAMEWORK_ASSERTION = "framework-mounted";

export function parse(output) {
  const results = [];
  let done = null;
  const errors = [];
  const late = [];

  for (const raw of String(output).split(/\r?\n/)) {
    const line = raw.trimEnd();
    let m = LINE.exec(line);
    if (m) {
      try {
        results.push(JSON.parse(m[1]));
      } catch (e) {
        errors.push(`unparseable result line: ${line}`);
      }
      continue;
    }
    m = DONE.exec(line);
    if (m) {
      try {
        done = JSON.parse(m[1]);
      } catch {
        done = [];
      }
      continue;
    }
    m = ERROR.exec(line);
    if (m) {
      errors.push(`page threw: ${JSON.parse(m[1])}`);
      continue;
    }
    m = LATE.exec(line);
    if (m) late.push(m[1].trim());
  }

  return { results, done, errors, late };
}

/**
 * Turn parsed output into a verdict. Returns { ok, failures } where failures
 * is a list of human-readable strings — each names the assertion and the
 * measured value, so a red run says what the number actually was.
 */
export function verdict(parsed, expected) {
  const failures = [...parsed.errors];
  const byName = new Map();
  for (const r of parsed.results) {
    if (byName.has(r.name)) failures.push(`duplicate assertion: ${r.name}`);
    byName.set(r.name, r);
  }

  for (const name of expected) {
    const r = byName.get(name);
    if (!r) {
      failures.push(`MISSING assertion '${name}' — the page never reported it`);
      continue;
    }
    if (!r.pass) {
      failures.push(`FAILED ${name}: ${JSON.stringify(r.value)}`);
    }
  }

  for (const r of parsed.results) {
    if (!expected.includes(r.name)) failures.push(`unexpected assertion: ${r.name}`);
  }

  if (parsed.done === null) {
    failures.push("the page never printed JANELA_TEST_DONE (crashed or hung before finishing)");
  }

  return { ok: failures.length === 0, failures, count: byName.size };
}

export function summarise(parsed) {
  return parsed.results
    .map((r) => `  ${r.pass ? "pass" : "FAIL"}  ${r.name}  ${JSON.stringify(r.value)}`)
    .join("\n");
}
