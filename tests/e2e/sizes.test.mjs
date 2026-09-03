// Tests for the size-figure gate on the landing page.
//
// `check:sizes` already gates every "N–M KB" *range*, which is what stopped
// "roughly 380–520 KB, desktop or mobile" from outliving the release that took
// desktop to 191 KB. The landing page also carries a table of *single absolute*
// figures, one cell per platform per template, and a range check has nothing to
// say about those: they were correct when written, and nothing would have
// noticed them coming loose on the one surface a reader actually sees.
//
// So this file does to that checker what the suite does to itself elsewhere —
// mutates the input and insists the guard goes red, and red for the stated
// reason. A check that cannot fail is documentation, not a gate.
//
// Fast: nothing is scaffolded, nothing is built, no file is written. The page
// and the record are read once and mutated in memory.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkSiteFigures, kib, loadRecord } from "../../scripts/measure-sizes.mjs";
import { REPO } from "./lib/project.mjs";

const PAGE = join(REPO, "website", "index.html");
const page = () => readFileSync(PAGE, "utf8").replace(/\r\n/g, "\n");
const rec = loadRecord();

/** Replace once, asserting the anchor was really there — a no-op mutation would pass. */
function edit(text, from, to) {
  assert.ok(text.includes(from), `mutation anchor missing: ${from}`);
  return text.replace(from, to);
}

/** The figure the page currently shows for a platform/template pair. */
function cell(platformKey, template) {
  return kib(rec.platforms[platformKey].sizes[template]);
}

function complaints(text) {
  return checkSiteFigures(rec, text);
}

test("the page as committed agrees with the record", () => {
  assert.deepEqual(complaints(page()), []);
});

test("the record's own figures are what the page quotes", () => {
  // Not a tautology: this fails if the page and the record agree only because
  // checkSiteFigures found nothing to compare (a broken anchor, say).
  const text = page();
  for (const [key, plat] of Object.entries(rec.platforms)) {
    for (const t of ["vanilla", "vue"]) {
      if (plat.sizes[t] == null) continue;
      assert.ok(
        text.includes(`<td class="num">${cell(key, t)}</td>`),
        `page does not quote ${key}/${t} = ${cell(key, t)}`,
      );
    }
  }
});

test("a drifted figure is caught and both numbers are named", () => {
  const was = cell("darwin-arm64", "vanilla");
  const out = complaints(edit(page(), `<td class="num">${was}</td>`, `<td class="num">999 KB</td>`));
  assert.equal(out.length, 1);
  assert.match(out[0], /999 KB/);
  // The message must carry the truth as well as the error, or the reader has
  // to go and measure to find out what it should have said.
  assert.match(out[0], new RegExp(was.replace(" ", "\\s")));
});

test("every platform row is checked, not just the first", () => {
  for (const key of Object.keys(rec.platforms)) {
    const was = cell(key, "vue");
    const out = complaints(edit(page(), `<td class="num">${was}</td>`, `<td class="num">777 KB</td>`));
    assert.ok(
      out.some((p) => /777 KB/.test(p)),
      `${key}: a drifted figure went unreported`,
    );
  }
});

test("a dropped cell fails rather than shifting the columns", () => {
  const was = cell("ios-sim-arm64", "vue");
  const out = complaints(edit(page(), `<td class="num">${was}</td>`, ""));
  assert.ok(out.some((p) => /figure\(s\) for 2 column\(s\)/.test(p)), out.join("\n"));
});

test("a retitled row fails instead of silently going unchecked", () => {
  const out = complaints(edit(page(), ">iOS (simulator)<", ">Apple handheld<"));
  assert.ok(out.some((p) => /matches no known platform/.test(p)), out.join("\n"));
});

test("a row removed from the page is a failure, not a smaller table", () => {
  const text = page();
  const i = text.indexOf('<td class="plat">Android (APK)');
  assert.ok(i > 0);
  const cut = text.slice(0, text.lastIndexOf("<tr>", i)) + text.slice(text.indexOf("</tr>", i) + 5);
  const out = complaints(cut);
  assert.ok(out.some((p) => /android-emu-arm64.*no row/.test(p)), out.join("\n"));
});

test("a column renamed to another real template compares against that one", () => {
  // The subtle case: "With Svelte" is a template the record knows, so the
  // check must not accept the heading and keep comparing Vue's numbers.
  const out = complaints(edit(page(), "<th>With Vue</th>", "<th>With Svelte</th>"));
  assert.ok(out.some((p) => /svelte/i.test(p)), out.join("\n"));
});

test("a column naming no template is reported as such", () => {
  const out = complaints(edit(page(), "<th>With Vue</th>", "<th>With Angular</th>"));
  assert.ok(out.some((p) => /name no template in the record/.test(p)), out.join("\n"));
});

test("losing the table says so instead of passing vacuously", () => {
  // The failure mode that would quietly disable everything above.
  const out = complaints(edit(page(), "<th>Target</th>", "<th>Goal</th>"));
  assert.equal(out.length, 1);
  assert.match(out[0], /no size table found/);
  assert.match(out[0], /do not delete the check/);
});

test("a figure on the page with no counterpart in the record is reported", () => {
  const thinned = { ...rec, platforms: { ...rec.platforms } };
  thinned.platforms["darwin-arm64"] = {
    ...rec.platforms["darwin-arm64"],
    sizes: { ...rec.platforms["darwin-arm64"].sizes },
  };
  delete thinned.platforms["darwin-arm64"].sizes.vue;
  const out = checkSiteFigures(thinned, page());
  assert.ok(out.some((p) => /not in the record/.test(p)), out.join("\n"));
});
