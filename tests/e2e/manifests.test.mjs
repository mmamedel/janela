// Invariants across the workspace's package manifests.
//
// This file exists because of a failure that reached the registry: create-janela
// was published depending on `janela: ^0.14.3` while the janela in the repo was
// 0.15.0 — a range that EXCLUDES it. `pnpm create janela` would have installed
// the older janela and scaffolded the previous starter, which is the one thing
// the scaffolder exists to get right. Tightening it to `^0.15.0` then broke CI
// instead, because 0.15.0 was not on the registry yet and a checkout could not
// resolve it.
//
// Both failures are the same shape: a hand-maintained version range that has
// to agree with something else. The rule below removes the class rather than
// the two instances — inside the repo the dependency is the workspace
// protocol, so there is no range to drift, and the publish workflow writes the
// concrete one at publish time.
//
// Fast: reads manifests, builds nothing.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO } from "./lib/project.mjs";

const read = (p) => JSON.parse(readFileSync(join(REPO, p), "utf8"));

const janela = read("packages/janela/package.json");
const createJanela = read("packages/create-janela/package.json");

test("create-janela depends on janela through the workspace protocol", () => {
  const dep = createJanela.dependencies?.janela;
  assert.ok(dep, "create-janela must depend on janela — it invokes its CLI");
  assert.ok(
    dep.startsWith("workspace:"),
    `create-janela declares janela as ${JSON.stringify(dep)}. Inside the repo it has to be ` +
      `the workspace protocol ("workspace:^"), or a checkout asks the registry for a version ` +
      `that may not be published yet and CI cannot install. The publish workflow rewrites it ` +
      `to a concrete range.`,
  );
});

test("the published range is >=, not a caret", () => {
  // The third instance of one bug. On a 0.x version the caret pins the MINOR:
  // `^0.15.0` is `>=0.15.0 <0.16.0`, so a create-janela published during 0.15
  // went on scaffolding the 0.15 starter after janela 0.16 shipped — silently,
  // because installing it succeeds. A scaffolder wants the newest framework,
  // and republishing it on every janela minor is not a mechanism, it is a
  // thing to forget.
  const wf = readFileSync(join(REPO, ".github/workflows/publish.yml"), "utf8");
  const m = /npm pkg set dependencies\.janela="([^"]+)"/.exec(wf);
  assert.ok(m, "publish.yml must pin the janela dependency");
  assert.ok(
    m[1].startsWith(">="),
    `publish.yml pins janela as ${JSON.stringify(m[1])}. It has to be a >= range: ` +
      `a caret on a 0.x version excludes the next minor, which is how a published ` +
      `create-janela kept installing a superseded janela.`,
  );
});

test("the workflow that publishes create-janela rewrites that spec", () => {
  // The guard above is only safe because something replaces the workspace
  // spec before it reaches npm. If that step is ever dropped, the published
  // package would carry "workspace:^", which no consumer can install.
  const wf = readFileSync(join(REPO, ".github/workflows/publish.yml"), "utf8");
  assert.match(
    wf,
    /npm pkg set dependencies\.janela=/,
    "publish.yml must pin create-janela's janela dependency before publishing it",
  );
  assert.match(
    wf,
    /workspace spec survived the rewrite/,
    "the rewrite must be verified in the workflow, not assumed",
  );
});

test("create-janela ships only what it needs, and nothing stale", () => {
  // `files` is an allowlist: anything not named here is absent from the
  // tarball, which is how a 4 kB scaffolder stays 4 kB.
  assert.deepEqual(createJanela.files, ["index.mjs"]);
  assert.equal(createJanela.bin?.["create-janela"], "index.mjs");
  assert.equal(createJanela.type, "module");
});

test("both packages agree on the node they require", () => {
  // create-janela spawns janela's CLI with its own process.execPath, so a
  // laxer engine range here would run janela on a node it rejects.
  assert.equal(createJanela.engines?.node, janela.engines?.node);
});

test("janela's brand files are not in its published tarball", () => {
  // The mark is inlined into the templates at scaffold time; the SVGs are
  // repo assets for the README and the site. Shipping them would be dead
  // weight in every install.
  assert.ok(janela.files?.length, "janela must declare a files allowlist");
  assert.ok(
    !janela.files.some((f) => f.startsWith("brand")),
    "brand/ is a repo asset, not a package file",
  );
});
