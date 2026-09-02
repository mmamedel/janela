// janela's end-to-end regression suite.
//
//   pnpm test:e2e
//
// Env knobs:
//   JANELA_TEST_LANES=desktop,ios,android   default: desktop
//   JANELA_TEST_TEMPLATES=vanilla,vue,...   default: vanilla,vue
//   JANELA_TEST_BIG_MB=32                   size of the large-read file
//   JANELA_TEST_DRAIN_P99_MAX_MS=50         tail bound during that read
//   JANELA_TEST_SYNC_MAX_MS=150             sync latency bound while async pending
//   JANELA_TEST_KEEP=1                      keep fixture projects for inspection
//
// The mobile lanes need a booted simulator/emulator and are skipped when one
// is absent, so this file is safe to run anywhere.

import test from "node:test";
import assert from "node:assert/strict";
import { cleanup, prepareProject } from "./lib/project.mjs";
import { selectedLanes, selectedTemplates } from "./lib/lanes.mjs";
import {
  CORE_ASSERTIONS,
  FRAMEWORK_ASSERTION,
  parse,
  summarise,
  verdict,
} from "./lib/results.mjs";

const lanes = selectedLanes();
const templates = selectedTemplates();

for (const lane of lanes) {
  const skip = lane.available() ? false : `${lane.name}: no device/host available`;

  for (const template of templates) {
    test(`${lane.name} · ${template} · behaviour battery`, { skip, timeout: 30 * 60_000 }, () => {
      const project = prepareProject({
        template,
        name: `e2e-${lane.name}-${template}`,
      });
      try {
        const { output, exitCode, signal } = lane.run(project);
        const parsed = parse(output);
        const expected = [...CORE_ASSERTIONS];
        if (project.config.framework) expected.push(FRAMEWORK_ASSERTION);
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
      } finally {
        cleanup(project.dir);
      }
    });
  }

  // Quitting with a read and a 5s timer in flight must exit cleanly, and
  // neither continuation may fire afterwards.
  test(`${lane.name} · clean exit with work in flight`, { skip, timeout: 30 * 60_000 }, () => {
    const project = prepareProject({
      template: "vanilla",
      name: `e2e-${lane.name}-quit`,
      page: "quit-with-work.js",
      bigMb: Number(process.env.JANELA_TEST_BIG_MB ?? 32),
    });
    try {
      const startedAt = Date.now();
      const { output, exitCode, signal } = lane.run(project);
      const elapsed = Date.now() - startedAt;
      assert.match(output, /JANELA_TEST_WORK_STARTED/, "the page never started the work");
      const parsed = parse(output);

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
    } finally {
      cleanup(project.dir);
    }
  });
}
