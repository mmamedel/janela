// build.dynamic — janela's opt-in to scriptc's `--dynamic` mode.
//
// scriptc's static tier rejects `any`-typed code outright (SC2011/SC2013):
// opting a janela project into `"build": { "dynamic": true }` in
// janela.conf.json threads scriptc's `--dynamic` flag through, embedding
// quickjs-ng so that tier compiles and runs instead. Desktop only — a mobile
// build is always a scriptc `--lib` build, and scriptc 0.0.36 rejects
// `--dynamic` there outright, so janela fails loudly before touching
// zig/Xcode/the NDK.
//
// The two build-heavy cases below (a real desktop compile, with and without
// the opt-in) are gated behind the same desktop-lane selection every other
// e2e test respects (JANELA_TEST_LANES) — an extra ~1.5 desktop builds per CI
// runner is not something `--dynamic`'s still-unverified linking on every
// lane (llvm-mingw, GTK/WebKitGTK) should cost silently. The two mobile-error
// cases need no simulator/emulator and no desktop build, so they stay
// unconditional like the CLI-only checks in packages/janela/test/unit/cli.test.mjs.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { selectList } from "./lib/env.mjs";
import { DESKTOP, LANES } from "./lib/lanes.mjs";
import { cleanup, cli, scratchRoot } from "./lib/project.mjs";

const BIG_BUFFER = { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 };

// Mirrors selectedLanes()'s own selector (lib/lanes.mjs), but does not throw
// when desktop is not what was asked for — unlike e2e.test.mjs, a run scoped
// to `JANELA_TEST_LANES=ios` should simply skip these two, not fail the file
// over a lane it was never asked to cover.
const { chosen: chosenLanes } = selectList({
  name: "JANELA_TEST_LANES",
  fallback: "desktop",
  valid: Object.keys(LANES),
  label: "lanes",
});
const desktopReady = chosenLanes.includes("desktop") && DESKTOP.available();
const skipDesktop = desktopReady ? false : "desktop lane not selected (JANELA_TEST_LANES) or unavailable";

// The trigger: an any-typed value flowing through the '+' operator. Passed as
// a plain function parameter rather than assigned to a local `const x: any`
// inside the caller — scriptc 0.0.36's island analysis picks up the site
// either way, but keeping the operator in its own top-level helper (called
// from setup(), the way a real command handler would call it) is the shape
// that reliably lands the site in the dynamic tier rather than being folded
// away as dead static code.
const DYNAMIC_MAIN_TS = `import type { JanelaApp } from "janela/host";

function dynamicProof(v: any): number {
  return v + 1;
}

export function setup(app: JanelaApp): void {
  console.log("DYNAMIC_PROOF:" + String(dynamicProof(JSON.parse("41"))));
  app.command("quit", (_args) => {
    app.quit();
    return null;
  });
}
`;

// A minimal page: no framework, no bundler — it only has to load and ask the
// host to quit, so the desktop process exits on its own instead of sitting
// with a window open until the run's timeout kills it.
const QUIT_ON_LOAD_HTML = `<!doctype html>
<html>
  <head><meta charset="utf-8" /></head>
  <body>
    <script>
      window.addEventListener("load", () => { window.janela.invoke("quit", null); });
    </script>
  </body>
</html>
`;

function scaffold(name) {
  const root = scratchRoot();
  mkdirSync(root, { recursive: true });
  const dir = join(root, name);
  rmSync(dir, { recursive: true, force: true });
  const made = cli(["init", name]);
  if (made.error || made.status !== 0) {
    throw new Error(`janela init failed (${made.error?.message ?? made.status}):\n${made.stdout}\n${made.stderr}`);
  }
  if (!existsSync(dir)) throw new Error(`janela init reported success but ${dir} is missing`);
  return dir;
}

function readConf(dir) {
  return JSON.parse(readFileSync(join(dir, "janela.conf.json"), "utf8"));
}

function writeConf(dir, conf) {
  writeFileSync(join(dir, "janela.conf.json"), JSON.stringify(conf, null, 2) + "\n", "utf8");
}

function writeDynamicHost(dir) {
  writeFileSync(join(dir, "src-host", "main.ts"), DYNAMIC_MAIN_TS, "utf8");
  writeFileSync(join(dir, "index.html"), QUIT_ON_LOAD_HTML, "utf8");
}

/** Run a built desktop binary and wait for it to exit on its own. */
function runDesktop(dir, name) {
  const exe = join(dir, ".janela", "out", process.platform === "win32" ? `${name}.exe` : name);
  if (!existsSync(exe)) throw new Error(`built binary missing: ${exe}`);
  const useXvfb = process.platform === "linux" && !process.env.DISPLAY;
  const cmd = useXvfb ? "xvfb-run" : exe;
  const args = useXvfb ? ["-a", exe] : [];
  // Same knob DESKTOP.run (lib/lanes.mjs) honors, and the same default —
  // a caller who widened the budget for a slow CI runner should not have it
  // silently ignored here.
  const timeout = Number(process.env.JANELA_TEST_RUN_TIMEOUT_MS ?? 300_000);
  const r = spawnSync(cmd, args, { ...BIG_BUFFER, cwd: dir, timeout });
  return { output: `${r.stdout ?? ""}\n${r.stderr ?? ""}`, exitCode: r.status, signal: r.signal };
}

test("desktop · build.dynamic: true compiles the any-typed handler and runs it", { skip: skipDesktop }, () => {
  const dir = scaffold("e2e-dynamic-desktop-ok");
  writeConf(dir, { ...readConf(dir), build: { dynamic: true } });
  writeDynamicHost(dir);

  let passed = false;
  try {
    const built = cli(["build"], { cwd: dir });
    assert.equal(
      built.status,
      0,
      `build.dynamic: true should compile the any-typed handler:\n${built.stdout}\n${built.stderr}`,
    );

    const { output, exitCode, signal } = runDesktop(dir, readConf(dir).name);
    assert.match(output, /DYNAMIC_PROOF:42/, `the dynamic-tier handler must have run:\n${output}`);
    assert.equal(signal, null, `app terminated by signal ${signal}`);
    assert.equal(exitCode, 0, `app exited ${exitCode}:\n${output}`);
    passed = true;
  } finally {
    if (passed) cleanup(dir);
  }
});

test("desktop · the same handler fails static compilation without the opt-in", { skip: skipDesktop }, () => {
  const dir = scaffold("e2e-dynamic-desktop-missing-optin");
  // No `build` section: static stays the default, exactly as it always has.
  writeDynamicHost(dir);

  let passed = false;
  try {
    const built = cli(["build"], { cwd: dir });
    assert.notEqual(built.status, 0, "an any-typed '+' must not compile in the static tier");
    assert.match(
      `${built.stdout}\n${built.stderr}`,
      /SC201[13]/,
      "scriptc's static-tier rejection must be the reason it failed",
    );
    passed = true;
  } finally {
    if (passed) cleanup(dir);
  }
});

for (const target of ["ios", "android"]) {
  test(`build.dynamic: true is a hard, early error on ${target} — no simulator/toolchain needed`, () => {
    const dir = scaffold(`e2e-dynamic-${target}-hard-error`);
    writeConf(dir, { ...readConf(dir), build: { dynamic: true } });
    // src-host/main.ts is left as the template's own — the check must fire
    // before janela even reads the entry point, let alone reaches zig/Xcode/
    // the NDK, so what main.ts contains does not matter here.

    let passed = false;
    try {
      const started = Date.now();
      const built = cli(["build", "--target", target], { cwd: dir });
      const elapsed = Date.now() - started;
      assert.notEqual(built.status, 0, `build.dynamic + --target ${target} must fail`);
      assert.match(built.stderr, /build\.dynamic is not supported for iOS\/Android/);
      // Generous, but this must fail before any real toolchain work starts —
      // a simulator boot or an NDK invocation would blow well past this.
      assert.ok(elapsed < 10_000, `should fail immediately, not after toolchain work (${elapsed}ms)`);
      passed = true;
    } finally {
      if (passed) cleanup(dir);
    }
  });
}
