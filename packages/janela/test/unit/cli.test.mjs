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
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

/**
 * A project with just janela.conf.json (no src-host/main.ts). `build` reads
 * and validates the config before it touches anything else, so a directory
 * this bare still exercises loadConf() and the mobile/dynamic gate below.
 *
 * Every MALFORMED-config case below (a bad type, an unknown key) fails
 * inside loadConf() itself — the very first thing build() does, before
 * assertDynamicSupported() and long before buildShim()/zig/Xcode/the NDK —
 * so those stay fast and toolchain-free on any target, desktop included.
 *
 * A VALID `dynamic` on a mobile target is just as fast: assertDynamicSupported()
 * rejects it right after loadConf(), still before buildShim() (skipped for
 * mobile anyway) or any zig/Xcode/NDK call. A valid `dynamic` on desktop is
 * NOT free, though — nothing stands between loadConf()/assertDynamicSupported()
 * and buildShim() there, so a case that reaches that path for real always pays
 * for a shim compile. There is deliberately no such case in this file; e2e's
 * dynamic.test.mjs covers the desktop-accepts-dynamic path, at that cost, once.
 */
function bareProject(name, conf) {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "janela.conf.json"), JSON.stringify(conf), "utf8");
  return dir;
}

const BASE_CONF = { name: "dyntest", identifier: "dev.janela.dyntest", window: { title: "t" } };

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

// ---- build.dynamic ----------------------------------------------------------
//
// --dynamic embeds quickjs-ng so `any`-typed code and npm-dependency JS can
// run; janela opts a project in through janela.conf.json's `build` namespace
// rather than a CLI flag. loadConf() validates the field before build() does
// anything else, and assertDynamicSupported() (the iOS/Android check) sits
// right after — both ahead of buildShim()/zig/Xcode/NDK. See bareProject()'s
// docstring above for exactly which cases that keeps fast, and which one
// (deliberately absent here) does not.

test("build rejects a non-boolean build.dynamic", () => {
  const dir = bareProject("dyn-bad-type", { ...BASE_CONF, build: { dynamic: "yes" } });
  const r = cli(["build"], dir);
  assert.equal(r.status, 1, "a non-boolean value must not be coerced and accepted");
  assert.match(r.stderr, /'build\.dynamic' must be a boolean/);
});

test("build rejects a 'build' section that isn't an object", () => {
  const dir = bareProject("dyn-bad-namespace", { ...BASE_CONF, build: "oops" });
  const r = cli(["build"], dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /'build' must be an object/);
});

test("build rejects an unknown key inside 'build'", () => {
  // A typo like this used to build static and silently: 'build.dynamik' was
  // never read, so nothing threaded --dynamic through and nothing said so.
  const dir = bareProject("dyn-bad-key", { ...BASE_CONF, build: { dynamik: true } });
  const r = cli(["build"], dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /'build' has an unknown key 'dynamik'/);
});

test("build.dynamic: true is a hard, early error on iOS — no zig/Xcode needed", () => {
  const dir = bareProject("dyn-ios-hard-error", { ...BASE_CONF, build: { dynamic: true } });
  const r = cli(["build", "--target", "ios"], dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /build\.dynamic is not supported for iOS\/Android/);
  assert.doesNotMatch(r.stderr, /missing src-host\/main\.ts/, "must fail before reaching the entry point check");
});

test("build.dynamic: true is a hard, early error on Android too", () => {
  const dir = bareProject("dyn-android-hard-error", { ...BASE_CONF, build: { dynamic: true } });
  const r = cli(["build", "--target", "android"], dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /build\.dynamic is not supported for iOS\/Android/);
});

test("build.dynamic: false passes validation on iOS (fails later, on the missing entry point)", () => {
  const dir = bareProject("dyn-ios-false-ok", { ...BASE_CONF, build: { dynamic: false } });
  const r = cli(["build", "--target", "ios"], dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /missing src-host\/main\.ts/, "a valid false must not trip the boolean or mobile check");
});

// `dev --target ios|android` reaches its own toolchain checks (iosDeviceOrFail
// / androidSdk) BEFORE build() runs, so assertDynamicSupported() has to be
// called at the top of devIos/devAndroid too, not just inside build() — this
// is the regression that would slip through if it were only called there.
// bareProject's config is enough: dev's own toolchain probes must never run.
for (const target of ["ios", "android"]) {
  test(`dev --target ${target} with build.dynamic: true fails before ${
    target === "ios" ? "xcrun/simctl" : "the Android SDK/NDK"
  }`, () => {
    const dir = bareProject(`dyn-dev-${target}-hard-error`, { ...BASE_CONF, build: { dynamic: true } });
    const r = cli(["dev", "--target", target], dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /build\.dynamic is not supported for iOS\/Android/);
  });
}
