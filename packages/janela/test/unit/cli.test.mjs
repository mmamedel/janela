/**
 * Tests for the CLI's argument surface, driven as a subprocess.
 *
 * These run the real binary rather than an extracted helper, because what
 * matters here is the whole observable contract — the message, and above all
 * the exit code. Every case below used to be a SILENT failure:
 *
 *   - a rejected project name printed nothing useful, so a script did
 *     `janela init my_app && cd my_app && ... | grep -c error` and read "0"
 *     as success;
 *   - a mistyped `--targt ios` fell back to the desktop default, built the
 *     wrong artifact and exited 0;
 *   - `janela init a b` created 'a' and never mentioned 'b'.
 *
 * A non-zero exit is the assertion that matters. The messages are asserted
 * loosely (a distinctive phrase) so wording can be improved without breaking
 * the suite.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "janela.mjs");
const tmp = mkdtempSync(join(tmpdir(), "janela-cli-test-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

function cli(args, cwd = tmp) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
}

test("no arguments prints usage and exits 0", () => {
  const r = cli([]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /usage: janela init/);
});

test("an unknown subcommand exits non-zero", () => {
  assert.notEqual(cli(["frobnicate"]).status, 0);
});

test("init accepts an underscore in a project name", () => {
  const r = cli(["init", "under_score"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(tmp, "under_score", "janela.conf.json")));
});

test("init rejects an unusable name, exits 1, and creates nothing", () => {
  const r = cli(["init", "My App"]);
  assert.equal(r.status, 1, "a rejected name must exit non-zero");
  assert.match(r.stderr, /not a usable project name/);
  assert.match(r.stderr, /Nothing was created/);
  assert.match(r.stderr, /my-app/, "the error should suggest a name that works");
  assert.ok(!existsSync(join(tmp, "My App")), "nothing may be created");
});

test("init rejects a name that cannot be repaired, without suggesting nonsense", () => {
  const r = cli(["init", "!!!"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not a usable project name/);
});

test("init rejects an extra positional and creates nothing", () => {
  const r = cli(["init", "keeper", "stray"]);
  assert.equal(r.status, 1, "a dropped argument must not look like success");
  assert.match(r.stderr, /unexpected extra argument 'stray'/);
  assert.ok(!existsSync(join(tmp, "keeper")), "nothing may be created");
});

test("init rejects an unknown flag with a suggestion", () => {
  const r = cli(["init", "flagged", "--templat", "vue"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown option '--templat'/);
  assert.match(r.stderr, /--template/, "should point at the flag that was meant");
});

test("init rejects an unknown template", () => {
  const r = cli(["init", "badtpl", "--template", "angular"]);
  assert.equal(r.status, 1);
});

test("build rejects a mistyped --target instead of silently building desktop", () => {
  // The original bug: --targt was ignored, the desktop artifact was built,
  // and the exit code was 0.
  const r = cli(["build", "--targt", "ios"]);
  assert.equal(r.status, 1, "a mistyped flag must not build the wrong thing");
  assert.match(r.stderr, /unknown option '--targt'/);
  assert.match(r.stderr, /--target/);
});

test("build rejects an unknown target value", () => {
  const r = cli(["build", "--target", "tvos"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown target 'tvos'/);
});

test("build outside a project says so rather than failing obscurely", () => {
  const r = cli(["build"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /janela\.conf\.json/);
});
