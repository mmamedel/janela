// janela's end-to-end regression suite.
//
//   pnpm test:e2e
//
// Every environment knob, its default and its meaning live in one place:
// `lib/env.mjs`. That module is also the gate — an unrecognised JANELA_*
// variable, or a selector that narrows the run to nothing, fails the run
// before the first test is defined. See docs/testing.md ("Failing loudly").
//
// The mobile lanes need a booted simulator/emulator. Selecting one that is not
// there is an error, not a skip: a run that quietly covers less than it was
// asked to must not be able to look green.

import test from "node:test";
import assert from "node:assert/strict";
import { cleanup, prepareProject } from "./lib/project.mjs";
import { selectedLanes, selectedTemplates } from "./lib/lanes.mjs";
import { assertKnownEnv, KNOBS } from "./lib/env.mjs";
import {
  CORE_ASSERTIONS,
  DESKTOP_ASSERTIONS,
  FRAMEWORK_ASSERTION,
  parse,
  summarise,
  verdict,
} from "./lib/results.mjs";

assertKnownEnv();

const { lanes, skipped } = selectedLanes();
const { chosen: templates } = selectedTemplates();

// What this run is about to cover, before it covers it. Printed unconditionally
// so the log says which lanes and templates the numbers below belong to — the
// count alone ("# pass 3") never distinguished three desktop tests from three
// iOS ones.
const knobsSet = Object.keys(KNOBS).filter((k) => process.env[k] !== undefined);
console.log(
  [
    "",
    `janela e2e — ${lanes.length} lane(s) x ${templates.length} template(s)`,
    `  lanes:     ${lanes.map((l) => l.name).join(", ")}`,
    `  templates: ${templates.join(", ")}`,
    skipped.length ? `  SKIPPED:   ${skipped.map((l) => `${l.name} (${l.hint})`).join(", ")}` : null,
    `  knobs set: ${knobsSet.length ? knobsSet.map((k) => `${k}=${process.env[k]}`).join(" ") : "(none — all defaults)"}`,
    "",
  ]
    .filter((l) => l !== null)
    .join("\n"),
);

// Which batteries actually reached their assertions. Counted rather than
// inferred from the exit status, and reported at the end, so "it passed" always
// comes with what it passed on.
const covered = [];
process.on("exit", () => {
  const expected = lanes.length * templates.length + lanes.length;
  console.log(
    `\njanela e2e — ran ${covered.length}/${expected} test(s): ${covered.join(", ") || "NOTHING"}` +
      (skipped.length ? `\n  lanes skipped by JANELA_TEST_SKIP_UNAVAILABLE: ${skipped.map((l) => l.name).join(", ")}` : ""),
  );
});

for (const lane of lanes) {
  for (const template of templates) {
    test(`${lane.name} · ${template} · behaviour battery`, { timeout: 30 * 60_000 }, () => {
      const project = prepareProject({
        template,
        name: `e2e-${lane.name}-${template}`,
      });
      // Kept on failure: the built project is the only record of what was
      // actually compiled and run, and CI uploads it as an artifact.
      let passed = false;
      try {
        const { output, exitCode, signal } = lane.run(project);
        const parsed = parse(output, project.config.runId);
        const expected = [...CORE_ASSERTIONS];
        if (project.config.framework) expected.push(FRAMEWORK_ASSERTION);
        if (lane.name === "desktop") expected.push(...DESKTOP_ASSERTIONS);
        const v = verdict(parsed, expected);

        // Reported even on success: the numbers are the interesting part.
        console.log(`\n${lane.name} · ${template} — ${v.count} assertions\n${summarise(parsed)}`);

        assert.equal(
          v.ok,
          true,
          `${lane.name}/${template} failed ${v.failures.length} check(s):\n` +
            v.failures.map((f) => `  - ${f}`).join("\n") +
            `\n\n--- app output (tail) ---\n${output.split(/\r?\n/).slice(-40).join("\n")}`,
        );
        // Exit status is a weaker signal than the assertions — a page that
        // throws still exits 0 — but a crash or a signal still matters.
        assert.equal(signal, null, `app terminated by signal ${signal}`);
        if (lane.name === "desktop") assert.equal(exitCode, 0, `app exited ${exitCode}`);
        passed = true;
        covered.push(`${lane.name}/${template}`);
      } finally {
        if (passed) cleanup(project.dir);
      }
    });
  }

  // Quitting with a read and a 5s timer in flight must exit cleanly, and
  // neither continuation may fire afterwards.
  test(`${lane.name} · clean exit with work in flight`, { timeout: 30 * 60_000 }, () => {
    const project = prepareProject({
      template: "vanilla",
      name: `e2e-${lane.name}-quit`,
      page: "quit-with-work.js",
      bigMb: Number(process.env.JANELA_TEST_BIG_MB ?? 32),
    });
    let passed = false;
    try {
      const startedAt = Date.now();
      const { output, exitCode, signal } = lane.run(project);
      const elapsed = Date.now() - startedAt;
      assert.ok(
        output.includes(`JANELA_TEST_WORK_STARTED ${project.config.runId}`),
        "the page never started the work (or the log belongs to an earlier run)",
      );
      const parsed = parse(output, project.config.runId);

      // What janela actually promises here is that quitting does not hang and
      // does not abandon the process to a pending timer. It deliberately
      // *joins* fs workers at shutdown, so a read that finishes during that
      // drain is correct behaviour, not a leak — hence `read-finished` is
      // allowed while `timer-finished` is not.
      assert.ok(
        !parsed.late.includes("timer-finished"),
        `quit waited for a pending 5s timer instead of exiting: ${parsed.late.join(", ")}`,
      );
      assert.ok(
        elapsed < 5000 + Number(process.env.JANELA_TEST_QUIT_SLACK_MS ?? 60_000),
        `quitting with work in flight took ${elapsed}ms — it looks like it waited for the 5s timer`,
      );
      assert.equal(signal, null, `app terminated by signal ${signal}`);
      if (lane.name === "desktop") assert.equal(exitCode, 0, `app exited ${exitCode}`);
      passed = true;
      covered.push(`${lane.name}/quit`);
    } finally {
      if (passed) cleanup(project.dir);
    }
  });
}
