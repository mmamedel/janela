// The suite's environment contract.
//
// A knob spelled wrong used to change nothing at all: `JANELA_E2E_TARGETS=ios`
// ran the desktop lane, reported "# pass 3" and exited 0 — the iOS coverage the
// caller asked for never existed, and nothing in the output said so. The same
// went for narrowing: `JANELA_TEST_TEMPLATES=` selected no templates, defined
// one test instead of three, and still exited 0.
//
// So this module holds the whole contract and enforces two rules:
//   1. every JANELA_* variable in the environment must be one the suite knows;
//   2. a selection may never narrow the run to nothing.
// A suite that tests less than it was asked to must not be able to look green.

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { REPO } from "./project.mjs";

/** Every variable the suite itself reads, with the default it falls back to. */
export const KNOBS = {
  JANELA_TEST_LANES: "lanes to exercise, comma-separated — default: desktop",
  JANELA_TEST_TEMPLATES: "templates to exercise, comma-separated — default: vanilla,vue",
  JANELA_TEST_SKIP_UNAVAILABLE: "skip selected lanes with no device attached instead of failing",
  JANELA_TEST_BIG_MB: "size of the large-read file, in MB — default: 32",
  JANELA_TEST_DRAIN_P99_MAX_MS: "tail latency bound during the large read — default: 50",
  JANELA_TEST_SYNC_MAX_MS: "sync latency bound while an async call is pending — default: 150",
  JANELA_TEST_ASYNC_MS: "how long the async command sleeps — default: 300",
  JANELA_TEST_QUIT_SLACK_MS: "slack over the 5s timer when judging quit time — default: 60000",
  JANELA_TEST_RUN_TIMEOUT_MS: "per-run budget for build+run — default: 300000",
  JANELA_TEST_SCRATCH: "where fixture projects are written — default: <repo>/.janela-tests",
  JANELA_TEST_KEEP: "keep fixture projects for inspection instead of deleting them",
};

/**
 * Variables the suite does not read but the janela CLI does, and the suite
 * spawns the CLI with the ambient environment. Rejecting these would break a
 * contributor whose shell legitimately carries them.
 */
export const PASSTHROUGH = {
  JANELA_WEBVIEW2_INCLUDE: "read by the CLI: WebView2 headers on Windows",
  JANELA_ANDROID_STORE_PASSWORD: "read by the CLI: Android release signing",
};

/**
 * The template list, derived rather than restated: `vanilla` is the base at the
 * top of templates/, each framework is a subdirectory. The CLI's own TEMPLATES
 * is module-private, so a copy here would be free to rot; a new template
 * directory shows up in this list on its own.
 */
export function knownTemplates() {
  const root = join(REPO, "packages", "janela", "templates");
  const dirs = readdirSync(root).filter((e) => statSync(join(root, e)).isDirectory());
  return ["vanilla", ...dirs.sort()];
}

function distance(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const next = Math.min(
        prev[j] + 1,
        prev[j - 1] + 1,
        diag + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diag = prev[j];
      prev[j] = next;
    }
  }
  return prev[b.length];
}

/** The nearest known name, when one is close enough to be worth naming. */
function nearest(name, candidates) {
  let best = null;
  for (const c of candidates) {
    const d = distance(name, c);
    if (d <= Math.max(2, Math.floor(c.length / 4)) && (!best || d < best.d)) best = { c, d };
  }
  return best?.c ?? null;
}

/**
 * Reject any JANELA_* variable the suite does not understand. Called before the
 * first test is defined, so a typo fails the run instead of quietly changing
 * what it covers.
 */
export function assertKnownEnv(env = process.env) {
  const known = [...Object.keys(KNOBS), ...Object.keys(PASSTHROUGH)];
  const unknown = Object.keys(env)
    .filter((k) => k.startsWith("JANELA_") && !known.includes(k))
    .sort();
  if (unknown.length === 0) return;

  const lines = unknown.map((k) => {
    const near = nearest(k, known);
    return `  ${k}=${JSON.stringify(env[k] ?? "")}${near ? `   (did you mean ${near}?)` : ""}`;
  });
  throw new Error(
    `unrecognised janela test variable${unknown.length > 1 ? "s" : ""}:\n${lines.join("\n")}\n\n` +
      `Nothing was run. A variable the suite does not read cannot change what it\n` +
      `covers, so a typo here is a silent loss of coverage.\n\n` +
      `Known knobs:\n` +
      Object.entries(KNOBS).map(([k, d]) => `  ${k}\n      ${d}`).join("\n") +
      `\nPassed through to the CLI:\n` +
      Object.entries(PASSTHROUGH).map(([k, d]) => `  ${k}\n      ${d}`).join("\n"),
  );
}

/**
 * Parse a comma-separated selector. Unset means the default; set-but-selecting
 * nothing is an error, because that is the shape that used to define zero tests
 * and report a pass.
 */
export function selectList({ name, fallback, valid, label }) {
  const raw = process.env[name];
  const explicit = raw !== undefined;
  const chosen = (explicit ? raw : fallback)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (chosen.length === 0) {
    throw new Error(
      `${name}=${JSON.stringify(raw)} selects no ${label}, so the run would cover nothing.\n` +
        `  Unset it for the default (${fallback}), or name at least one of: ${valid.join(", ")}.`,
    );
  }
  for (const item of chosen) {
    if (valid.includes(item)) continue;
    const near = nearest(item, valid);
    throw new Error(
      `unknown ${label.replace(/s$/, "")} '${item}' in ${name}.\n` +
        `  Known: ${valid.join(", ")}.${near ? `\n  Did you mean '${near}'?` : ""}`,
    );
  }
  return { chosen, explicit };
}
