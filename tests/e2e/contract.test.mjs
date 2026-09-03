// Tests for the suite's own environment gate.
//
// This file exists because the failure it guards against is invisible: when a
// selector silently narrowed the run, the suite reported a pass. Nothing else
// in the repo would have caught that, so the gate needs its own coverage —
// including a mutation-style check that the gate can actually fail.
//
// Fast: no project is scaffolded and nothing is built.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { KNOBS, PASSTHROUGH, assertKnownEnv, knownTemplates, selectList } from "./lib/env.mjs";
import { IOS, LANES, selectedLanes, selectedTemplates } from "./lib/lanes.mjs";
import { REPO } from "./lib/project.mjs";

const clean = { PATH: "/usr/bin", HOME: "/tmp", LANG: "C" };

test("a clean environment passes the gate", () => {
  assert.doesNotThrow(() => assertKnownEnv(clean));
});

test("every documented knob is accepted", () => {
  for (const k of Object.keys(KNOBS)) {
    assert.doesNotThrow(() => assertKnownEnv({ ...clean, [k]: "1" }), k);
  }
});

test("CLI variables the suite forwards are accepted", () => {
  for (const k of Object.keys(PASSTHROUGH)) {
    assert.doesNotThrow(() => assertKnownEnv({ ...clean, [k]: "x" }), k);
  }
});

test("an unknown JANELA_ variable is rejected and named", () => {
  assert.throws(
    () => assertKnownEnv({ ...clean, JANELA_E2E_TARGETS: "ios,android" }),
    (e) => {
      assert.match(e.message, /unrecognised janela test variable/);
      assert.match(e.message, /JANELA_E2E_TARGETS="ios,android"/);
      assert.match(e.message, /Nothing was run/);
      // The message has to carry the alternatives; a rejection the caller
      // cannot act on just moves the confusion.
      assert.match(e.message, /JANELA_TEST_LANES/);
      return true;
    },
  );
});

test("a near-miss variable name gets a suggestion", () => {
  for (const [typo, want] of [
    ["JANELA_TEST_TEMPLATE", "JANELA_TEST_TEMPLATES"],
    ["JANELA_TEST_LANE", "JANELA_TEST_LANES"],
    ["JANELA_TEST_KEP", "JANELA_TEST_KEEP"],
  ]) {
    assert.throws(
      () => assertKnownEnv({ ...clean, [typo]: "x" }),
      new RegExp(`did you mean ${want}\\?`),
      typo,
    );
  }
});

test("a name too far from any knob gets no invented suggestion", () => {
  assert.throws(
    () => assertKnownEnv({ ...clean, JANELA_SOMETHING_ELSE_ENTIRELY: "x" }),
    (e) => {
      assert.doesNotMatch(e.message, /did you mean/);
      return true;
    },
  );
});

test("variables outside the JANELA_ namespace are none of the gate's business", () => {
  assert.doesNotThrow(() => assertKnownEnv({ ...clean, CI: "true", NODE_OPTIONS: "--x" }));
});

// --- selectors -------------------------------------------------------------

const SEL = { name: "JANELA_TEST_FAKE", fallback: "a,b", valid: ["a", "b", "c"], label: "things" };

/**
 * Set (or clear) variables for the duration of `fn`, restoring exactly what was
 * there before. These tests must not read the ambient environment: CI runs the
 * suite with JANELA_TEST_TEMPLATES already set, so a test asserting the default
 * would pass there only because CI happens to set the same value.
 */
function withEnvVars(vars, fn) {
  const saved = new Map();
  for (const [k, v] of Object.entries(vars)) {
    saved.set(k, Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : undefined);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const withEnv = (value, fn) => withEnvVars({ [SEL.name]: value }, fn);

test("an unset selector takes the default", () => {
  const { chosen, explicit } = withEnv(undefined, () => selectList(SEL));
  assert.deepEqual(chosen, ["a", "b"]);
  assert.equal(explicit, false);
});

test("a selector that selects nothing is an error, not an empty run", () => {
  for (const empty of ["", " ", ",", " , , "]) {
    assert.throws(
      () => withEnv(empty, () => selectList(SEL)),
      /selects no things, so the run would cover nothing/,
      JSON.stringify(empty),
    );
  }
});

test("a selector naming something unknown is an error", () => {
  assert.throws(() => withEnv("a,zzz", () => selectList(SEL)), /unknown thing 'zzz'/);
});

test("templates: the default is two, and every known template is selectable", () => {
  withEnvVars({ JANELA_TEST_TEMPLATES: undefined }, () => {
    assert.deepEqual(selectedTemplates().chosen, ["vanilla", "vue"]);
  });
  for (const t of knownTemplates()) {
    withEnvVars({ JANELA_TEST_TEMPLATES: t }, () => {
      assert.deepEqual(selectedTemplates().chosen, [t]);
    });
  }
});

/**
 * The CLI owns the real template list in a module-private const, so this
 * suite derives its own from the templates directory. If the two ever
 * disagree, the derivation is wrong and the e2e matrix is testing a set of
 * templates the CLI does not accept.
 */
test("the derived template list matches the CLI's own", () => {
  const src = readFileSync(join(REPO, "packages", "janela", "bin", "janela.mjs"), "utf8");
  const m = /^const TEMPLATES = (\[[^\]]*\]);$/m.exec(src);
  assert.ok(m, "could not find TEMPLATES in the CLI — update this test's parser");
  const cli = JSON.parse(m[1].replace(/'/g, '"'));
  assert.deepEqual([...knownTemplates()].sort(), [...cli].sort());
});

// --- lane availability -----------------------------------------------------

function withLane(lane, available, envs, fn) {
  const real = lane.available;
  lane.available = () => available;
  try {
    return withEnvVars(envs, fn);
  } finally {
    lane.available = real;
  }
}

test("selecting a lane with no device is an error, and says how to fix it", () => {
  withLane(IOS, false, { JANELA_TEST_LANES: "ios", JANELA_TEST_SKIP_UNAVAILABLE: undefined }, () => {
    assert.throws(() => selectedLanes(), (e) => {
      assert.match(e.message, /lane 'ios' was selected but has no device\/host available/);
      assert.match(e.message, /simctl boot/);
      assert.match(e.message, /JANELA_TEST_SKIP_UNAVAILABLE=1/);
      return true;
    });
  });
});

test("with SKIP_UNAVAILABLE the gap is allowed but reported", () => {
  withLane(IOS, false, { JANELA_TEST_LANES: "desktop,ios", JANELA_TEST_SKIP_UNAVAILABLE: "1" }, () => {
    const { lanes, skipped } = selectedLanes();
    assert.deepEqual(lanes.map((l) => l.name), ["desktop"]);
    assert.deepEqual(skipped.map((l) => l.name), ["ios"]);
  });
});

test("SKIP_UNAVAILABLE still may not reduce the run to nothing", () => {
  withLane(IOS, false, { JANELA_TEST_LANES: "ios", JANELA_TEST_SKIP_UNAVAILABLE: "1" }, () => {
    assert.throws(() => selectedLanes(), /would cover nothing/);
  });
});

test("every lane can say how to become available", () => {
  for (const [name, lane] of Object.entries(LANES)) {
    assert.equal(typeof lane.hint, "string", `${name} has no hint`);
    assert.ok(lane.hint.length > 0, `${name}'s hint is empty`);
  }
});
