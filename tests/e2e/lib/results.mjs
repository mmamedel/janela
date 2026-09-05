// Parsing and bookkeeping for the battery's structured output.
//
// The one property that matters: a run passes only if EVERY expected
// assertion was seen. A page whose script throws still exits 0 and still
// prints "run returned 0", so absence — not a non-zero exit — is the signal
// that something broke. Several false green results on this project came from
// treating exit 0 as a pass.

const LINE = /JANELA_TEST (\{.*\})\s*$/;
const DONE = /JANELA_TEST_DONE (\{.*\})\s*$/;
const ERROR = /JANELA_TEST_ERROR (\{.*\})\s*$/;
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
  "large-file-staged",
  "large-read-correct",
  "large-read-bounded",
];

/** Emitted only where a framework actually renders (the Vite templates). */
export const FRAMEWORK_ASSERTION = "framework-mounted";

/**
 * Emitted only on the desktop lane. The battery reports `menu-installed`
 * everywhere, but a phone has no menu bar and `setMenu` says so by returning
 * false — so on iOS and Android the line is expected to be a FAIL, and
 * requiring it would make the mobile lanes red for behaving correctly.
 */
export const DESKTOP_ASSERTIONS = ["menu-installed", "menu-actions"];

/**
 * Parse the battery's output for ONE run.
 *
 * `runId` is required and every accepted line must carry it. Without this the
 * mobile lanes read the device log over a time window and will happily parse a
 * PREVIOUS run's results — which is how this harness briefly reported a stale
 * pass while a real regression sat in front of it.
 */
export function parse(output, runId) {
  if (!runId) throw new Error("parse() requires the run id");
  const results = [];
  let done = null;
  const errors = [];
  const late = [];

  for (const raw of String(output).split(/\r?\n/)) {
    const line = raw.trimEnd();
    let m = LINE.exec(line);
    if (m) {
      try {
        const r = JSON.parse(m[1]);
        if (r.run === runId) results.push(r);
      } catch {
        // A line that will not parse cannot be attributed by its payload, so
        // fall back to the raw text. Without this the device lanes — which
        // read a log over a time window, not a pipe — reported the CURRENT
        // run as failed because an EARLIER run of a DIFFERENT template had
        // left a malformed line in the window. Unparseable and not ours is
        // not our problem; unparseable and ours is a real failure.
        if (line.includes(runId)) errors.push(`unparseable result line: ${line}`);
      }
      continue;
    }
    m = DONE.exec(line);
    if (m) {
      try {
        const d = JSON.parse(m[1]);
        if (d.run === runId) done = d.seen ?? [];
      } catch {
        /* ignore a malformed DONE line; the missing-assertion check covers it */
      }
      continue;
    }
    m = ERROR.exec(line);
    if (m) {
      // Run-scoped for the same reason: a stack trace from a previous run in
      // the log window used to fail whichever test read it next.
      try {
        const e = JSON.parse(m[1]);
        if (e.run === runId) errors.push(`page threw: ${e.error}`);
      } catch {
        if (line.includes(runId)) errors.push(`unparseable error line: ${line}`);
      }
      continue;
    }
    m = LATE.exec(line);
    if (m && m[1].includes(runId)) late.push(m[1].replace(runId, "").trim());
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
