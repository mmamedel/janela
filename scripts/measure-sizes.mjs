#!/usr/bin/env node
// Measure what a janela app actually weighs, and keep the docs honest about it.
//
//   node scripts/measure-sizes.mjs --measure    # build the templates, record sizes
//   node scripts/measure-sizes.mjs --write      # re-render the doc tables from the record
//   node scripts/measure-sizes.mjs --check      # fail if any published figure has drifted
//
// The sizes in docs/frontend.md, both READMEs and the website were hand-typed
// and went stale in the ordinary way: 0.13.x added dialogs and os_log, and the
// table kept the 0.12.0 figures for two releases. There was nothing to notice
// it, because a number in prose has no test. `--check` is that test.
//
// docs/sizes.json is the single record; the doc tables are generated from it.
// A measurement carries the janela version, the scriptc pin and the host it
// came from, so a figure can never silently outlive what produced it.
//
// This script measures the DESKTOP column of the platform it runs on, and only
// that. iOS and Android need a simulator and an emulator, and their numbers
// come from the device lanes; `--check` reports them as unverifiable here
// rather than pretending, and never rewrites them.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const CLI = join(REPO, "packages", "janela", "bin", "janela.mjs");
const RECORD = join(REPO, "docs", "sizes.json");
const SCRATCH = process.env.JANELA_SIZES_SCRATCH
  ? resolve(process.env.JANELA_SIZES_SCRATCH)
  : join(REPO, ".janela-sizes");

const MARK_START = "<!-- sizes:start -->";
const MARK_END = "<!-- sizes:end -->";

/**
 * Read a text file with line endings normalised.
 *
 * Windows checks these files out with CRLF, so a comparison against a string
 * this script joined with "\n" reports drift that does not exist — which is
 * exactly how --check failed on windows-latest while passing on the other two
 * runners. Nothing here cares about line endings; everything here cares about
 * the numbers.
 */
const readText = (path) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

const die = (msg) => {
  console.error(`measure-sizes: ${msg}`);
  process.exit(1);
};

/** The platform key a desktop measurement belongs to. */
function hostKey() {
  return `${process.platform}-${process.arch}`;
}

function janelaVersion() {
  return JSON.parse(readFileSync(join(REPO, "packages", "janela", "package.json"), "utf8")).version;
}

/** The scriptc pin, which is what actually moves the desktop numbers. */
function scriptcVersion() {
  const pkg = JSON.parse(readFileSync(join(REPO, "packages", "janela", "package.json"), "utf8"));
  const spec = pkg.dependencies?.scriptc ?? pkg.devDependencies?.scriptc ?? pkg.peerDependencies?.scriptc;
  if (!spec) die("no scriptc dependency found in packages/janela/package.json");
  return spec.replace(/^[^0-9]*/, "");
}

function templates() {
  const root = join(REPO, "packages", "janela", "templates");
  return ["vanilla", ...readdirSync(root).filter((e) => statSync(join(root, e)).isDirectory()).sort()];
}

// --- measuring --------------------------------------------------------------

function du(path) {
  if (!existsSync(path)) die(`nothing to measure at ${path}`);
  const st = statSync(path);
  if (st.isFile()) return st.size;
  let total = 0;
  for (const entry of readdirSync(path)) total += du(join(path, entry));
  return total;
}

/**
 * The platforms this script can build and measure, and what "the shipped
 * artifact" means for each.
 *
 * Building needs the toolchain, NOT a device: `janela build --target ios`
 * compiles and lays out the .app without a simulator, and the Android build
 * needs a JDK and the SDK/NDK but no emulator. Only the e2e lanes need a
 * booted device. That is what makes refreshing these columns practical.
 */
const TARGETS = {
  desktop: {
    key: () => hostKey(),
    kind: "desktop",
    label: () => `desktop (${hostKey()})`,
    host: () => hostKey(),
    artifact: (dir, name) =>
      join(dir, ".janela", "out", process.platform === "win32" ? `${name}.exe` : name),
  },
  ios: {
    key: () => "ios-sim-arm64",
    kind: "mobile",
    label: () => "iOS `.app`",
    host: () => describeIos(),
    artifact: (dir, name) => join(dir, ".janela", "out-ios", `${name}.app`),
    // The bundle total is what ships; the executable inside it is the part
    // the linker actually changes, and the two differ by ~800 B of bundle
    // metadata, so both are worth recording.
    components: { "iOS binary": (dir, name) => join(dir, ".janela", "out-ios", `${name}.app`, name) },
  },
  android: {
    key: () => "android-emu-arm64",
    kind: "mobile",
    label: () => "Android `.apk`",
    host: () => describeAndroid(),
    artifact: (dir, name) => join(dir, ".janela", "out-android", `${name}.apk`),
    // The .so is inside the (compressed, aligned) APK, so its uncompressed
    // size cannot be measured from the APK itself. The CLI prints both as it
    // builds, and that line is the only place the staged path is named.
    componentsFromLog: (out) => {
      const m = /\.so (\d+) bytes/.exec(out);
      if (!m) die("could not read the .so size from the android build output — did its wording change?");
      return { "Android `.so`": Number(m[1]) };
    },
    env: () => ({ JAVA_HOME: javaHome() }),
  },
};

/** The JDK the Android build needs, including Homebrew's keg-only location. */
function javaHome() {
  if (process.env.JAVA_HOME) return process.env.JAVA_HOME;
  // Homebrew's openjdk is keg-only: absent from /usr/bin, from
  // /Library/Java/JavaVirtualMachines and from java_home, which is exactly
  // why a JDK here is easy to miss.
  const brew = "/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home";
  if (existsSync(join(brew, "bin", "java"))) return brew;
  die("android needs a JDK: set JAVA_HOME, or `brew install openjdk`");
}

function describeIos() {
  const l = spawnSync("xcrun", ["simctl", "list", "devices", "available"], { encoding: "utf8" });
  const runtime = /-- (iOS [\d.]+) --/.exec(l.stdout ?? "")?.[1] ?? "iOS";
  return `${runtime} simulator SDK, built on ${hostKey()}`;
}

function describeAndroid() {
  const home = process.env.ANDROID_HOME ?? join(process.env.HOME ?? "", "Library/Android/sdk");
  const bt = existsSync(join(home, "build-tools"))
    ? readdirSync(join(home, "build-tools")).sort().pop()
    : "unknown";
  return `Android arm64-v8a, build-tools ${bt}, built on ${hostKey()}`;
}

/**
 * Build one pristine template and return the size of the shipped artifact.
 *
 * Pristine on purpose: the e2e suite replaces src-host/main.ts with a fixture
 * that implements a superset of the contract, so its binaries are bigger than
 * anything a user gets. What is published has to be what `janela init` gives
 * you.
 */
function measureTemplate(template, targetName) {
  const target = TARGETS[targetName];
  // The name is fixed, and that matters: it is embedded in the binary, so a
  // longer project name builds a bigger one (230,592 B for a 2-character name
  // against 230,608 B for 16). Holding it constant is what makes
  // `--check --measure` reproduce the record byte for byte.
  const name = `size-${template}`;
  const dir = join(SCRATCH, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(SCRATCH, { recursive: true });

  const args = ["init", name];
  if (template !== "vanilla") args.push("--template", template);
  run(process.execPath, [CLI, ...args], SCRATCH, `janela init ${template}`);

  if (template !== "vanilla") {
    run("npm", ["install", "--no-audit", "--no-fund"], dir, `npm install (${template})`, true);
  }

  const buildArgs = [CLI, "build"];
  if (targetName !== "desktop") buildArgs.push("--target", targetName);
  const out = run(
    process.execPath,
    buildArgs,
    dir,
    `janela build${targetName === "desktop" ? "" : ` --target ${targetName}`} (${template})`,
    false,
    target.env?.(),
  );

  const conf = JSON.parse(readFileSync(join(dir, "janela.conf.json"), "utf8"));
  const total = du(target.artifact(dir, conf.name));
  const components = {};
  for (const [label, path] of Object.entries(target.components ?? {})) {
    components[label] = du(path(dir, conf.name));
  }
  Object.assign(components, target.componentsFromLog?.(out) ?? {});
  rmSync(dir, { recursive: true, force: true });
  return { total, components };
}

function run(cmd, args, cwd, label, needsShell = false, extraEnv) {
  const out = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
    maxBuffer: 64 * 1024 * 1024,
    timeout: 15 * 60_000,
    // npm is a .cmd shim on Windows and Node refuses to spawn it without one.
    shell: needsShell && process.platform === "win32",
  });
  if (out.error || out.status !== 0) {
    die(`${label} failed (${out.error?.message ?? `exit ${out.status}`}):\n${out.stdout ?? ""}\n${out.stderr ?? ""}`);
  }
  return out.stdout ?? "";
}

function measureAll(targetName) {
  const sizes = {};
  const components = {};
  for (const t of templates()) {
    process.stderr.write(`  building ${t} … `);
    const { total, components: c } = measureTemplate(t, targetName);
    sizes[t] = total;
    for (const [label, bytes] of Object.entries(c)) {
      (components[label] ??= {})[t] = bytes;
    }
    process.stderr.write(`${kib(total)}\n`);
  }
  return { sizes, components };
}

// --- the record -------------------------------------------------------------

function loadRecord() {
  if (!existsSync(RECORD)) die(`${RECORD} is missing — run --measure first`);
  return JSON.parse(readFileSync(RECORD, "utf8"));
}

function saveRecord(rec) {
  writeFileSync(RECORD, `${JSON.stringify(rec, null, 2)}\n`, "utf8");
}

const kib = (bytes) => `${Math.round(bytes / 1024)} KB`;

// --- rendering --------------------------------------------------------------

/**
 * The doc tables, generated. Column order follows the record's platform list,
 * and every platform states the janela version it was measured at — so a
 * column left behind by a release is visible in the doc itself, not just in
 * this script's exit status.
 */
function renderTables(rec) {
  // Desktop first, then mobile, each group alphabetical — so the layout does
  // not depend on the order platforms happen to sit in the JSON.
  const rank = (p) => (p.kind === "desktop" ? 0 : 1);
  const plats = Object.entries(rec.platforms).sort(
    ([ka, a], [kb, b]) => rank(a) - rank(b) || ka.localeCompare(kb),
  );
  // Rows ascending by the first column, which puts the smallest template at
  // the top and keeps the ordering meaningful as templates come and go.
  const primary = plats[0]?.[1]?.sizes ?? {};
  const ts = [...rec.templates].sort(
    (a, b) => (primary[a] ?? Infinity) - (primary[b] ?? Infinity) || a.localeCompare(b),
  );

  const head = `| template | ${plats.map(([, p]) => p.label).join(" | ")} |`;
  const rule = `|---|${plats.map(() => "---|").join("")}`;
  const rows = ts.map(
    (t) => `| ${t} | ${plats.map(([, p]) => (p.sizes[t] == null ? "—" : kib(p.sizes[t]))).join(" | ")} |`,
  );

  // The raw table also carries any sub-artifact a platform tracks — the iOS
  // executable inside the .app, the Android .so inside the .apk — because the
  // prose below the table reasons about them.
  const rawCols = [];
  for (const [, p] of plats) {
    rawCols.push({ label: p.label, get: (t) => p.sizes[t] });
    for (const [label, sizes] of Object.entries(p.components ?? {})) {
      rawCols.push({ label, get: (t) => sizes[t] });
    }
  }
  const rawHead = `| template | ${rawCols.map((c) => c.label).join(" | ")} |`;
  const rawRule = `|---|${rawCols.map(() => "---|").join("")}`;
  const rawRows = ts.map(
    (t) =>
      `| ${t} | ${rawCols.map((c) => (c.get(t) == null ? "—" : c.get(t).toLocaleString("en-US"))).join(" | ")} |`,
  );

  const provenance = plats.map(
    ([, p]) =>
      `- **${p.label}** — janela ${p.janela}, scriptc ${p.scriptc}, measured ${p.measured} on ${p.host}.` +
      (p.note ? ` ${p.note}` : ""),
  );

  return [
    MARK_START,
    "<!-- Generated by scripts/measure-sizes.mjs. Do not hand-edit: `--check` fails on drift. -->",
    "",
    head,
    rule,
    ...rows,
    "",
    "Sizes are rounded KiB of the shipped artifact. Raw bytes:",
    "",
    rawHead,
    rawRule,
    ...rawRows,
    "",
    "Where each column comes from:",
    "",
    ...provenance,
    "",
    MARK_END,
  ].join("\n");
}

function replaceBlock(file, block) {
  const text = readText(file);
  const a = text.indexOf(MARK_START);
  const b = text.indexOf(MARK_END);
  if (a === -1 || b === -1) die(`${file} has no ${MARK_START} / ${MARK_END} block`);
  const next = `${text.slice(0, a)}${block}${text.slice(b + MARK_END.length)}`;
  writeFileSync(file, next, "utf8");
  return next !== text;
}

// --- claims in prose --------------------------------------------------------

/**
 * The ranges quoted outside the generated table. These are prose, so they
 * cannot be generated without mangling the sentences around them — but they
 * can be checked, which is the part that was missing.
 *
 * The rule: every "N–M KB" span in these files must bracket something real —
 * one platform's spread, the mobile platforms together, or all of them. A
 * range that brackets nothing is a figure that has come loose from the build,
 * which is exactly how "roughly 380–520 KB, desktop or mobile" outlived a
 * release that took desktop down to 191 KB.
 */
const PROSE_FILES = ["README.md", "packages/janela/README.md", "website/index.html", "docs/frontend.md"];

function spans(rec) {
  const out = [];
  const span = (label, sizeMaps) => {
    const all = sizeMaps.flatMap((m) => Object.values(m)).filter((n) => n != null);
    if (all.length) out.push({ label, lo: Math.min(...all), hi: Math.max(...all) });
  };
  const entries = Object.entries(rec.platforms);
  for (const [k, p] of entries) span(k, [p.sizes]);
  // Grouped by declared kind, not by "whichever platform is not this host":
  // the same figures have to pass this check on a Linux runner too.
  const mobile = entries.filter(([, p]) => p.kind === "mobile");
  if (mobile.length > 1) span("mobile", mobile.map(([, p]) => p.sizes));
  const desktop = entries.filter(([, p]) => p.kind === "desktop");
  if (desktop.length > 1) span("desktop", desktop.map(([, p]) => p.sizes));
  span("all platforms", entries.map(([, p]) => p.sizes));
  return out;
}

/** A line carrying this is quoting something other than an absolute size. */
const EXEMPT_MARK = "<!-- sizes:not-a-size -->";

/** Every "N–M KB" span in a file, in bytes, with its line's exemption state. */
function quotedRanges(text) {
  const out = [];
  // 200–400 KB, 200-400 KB, 200&nbsp;–&nbsp;400&nbsp;KB
  const re = /(\d{2,4})(?:&nbsp;|\s)*[–-](?:&nbsp;|\s)*(\d{2,4})(?:&nbsp;|\s)*KB/g;
  for (const line of text.split("\n")) {
    const exempt = line.includes(EXEMPT_MARK);
    for (const m of line.matchAll(re)) {
      out.push({ text: m[0], lo: Number(m[1]) * 1024, hi: Number(m[2]) * 1024, exempt });
    }
  }
  return out;
}

function checkProse(rec) {
  const problems = [];
  const exempt = [];
  const candidates = spans(rec);
  for (const file of PROSE_FILES) {
    const text = readText(join(REPO, file));
    const ranges = quotedRanges(text);
    if (ranges.length === 0) {
      problems.push(`${file}: no "N–M KB" range found — did the wording change?`);
      continue;
    }
    for (const r of ranges) {
      // Not every "N-M KB" is a size: a sentence can legitimately quote a
      // spread between templates, a saving, or a delta, and none of those
      // bracket an absolute span. Marking the line opts it out — and the
      // check reports what it skipped, so an exemption cannot quietly become
      // the place stale numbers live.
      if (r.exempt) {
        exempt.push(`${file}: "${r.text}" (marked ${EXEMPT_MARK})`);
        continue;
      }
      // Compared in rounded KB, because that is what the prose quotes: the
      // true Android floor is 483,851 B, which a writer correctly renders as
      // "473 KB" — 501 bytes ABOVE the real number. A byte-exact comparison
      // rejects the honest figure.
      const ok = candidates.some((c) => {
        const [clo, chi] = [Math.round(c.lo / 1024), Math.round(c.hi / 1024)];
        const [rlo, rhi] = [Math.round(r.lo / 1024), Math.round(r.hi / 1024)];
        // Rounded prose may be wider than the truth, but not narrower, and
        // not so wide that it stops saying anything.
        return rlo <= clo && rhi >= chi && rlo >= clo * 0.8 && rhi <= chi * 1.25;
      });
      if (!ok) {
        problems.push(
          `${file}: "${r.text}" brackets none of the measured spreads ` +
            `(${candidates.map((c) => `${c.label} ${kib(c.lo)}–${kib(c.hi)}`).join("; ")})`,
        );
      }
    }
  }
  if (exempt.length) {
    console.error(`  Not checked (${EXEMPT_MARK}):`);
    for (const e of exempt) console.error(`    ${e}`);
  }
  return problems;
}

// --- commands ---------------------------------------------------------------

/** Which columns this host can actually build, and why not when it cannot. */
function measurable() {
  const out = {};
  out.desktop = true;
  out.ios = process.platform === "darwin" ? true : "needs Xcode on macOS";
  const sdk = process.env.ANDROID_HOME ?? join(process.env.HOME ?? "", "Library/Android/sdk");
  if (!existsSync(sdk)) out.android = "no Android SDK";
  else if (!process.env.JAVA_HOME && !existsSync("/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home/bin/java"))
    out.android = "no JDK (set JAVA_HOME, or `brew install openjdk`)";
  else out.android = true;
  return out;
}

function cmdMeasure(targetName) {
  const target = TARGETS[targetName];
  const can = measurable()[targetName];
  if (can !== true) die(`cannot measure ${targetName} here: ${can}`);

  const key = target.key();
  const rec = existsSync(RECORD) ? loadRecord() : { templates: templates(), platforms: {} };
  console.error(`measuring ${targetName} (janela ${janelaVersion()}, scriptc ${scriptcVersion()})`);
  const { sizes, components } = measureAll(targetName);

  const prev = rec.platforms[key]?.sizes ?? {};
  rec.templates = templates();
  rec.platforms[key] = {
    label: rec.platforms[key]?.label ?? target.label(),
    kind: target.kind,
    host: target.host(),
    janela: janelaVersion(),
    scriptc: scriptcVersion(),
    measured: new Date().toISOString().slice(0, 10),
    sizes,
    ...(Object.keys(components).length ? { components } : {}),
  };
  saveRecord(rec);

  for (const t of rec.templates) {
    const before = prev[t];
    const after = sizes[t];
    if (before == null || after == null) continue;
    const delta = after - before;
    if (delta !== 0) {
      const pct = ((delta / before) * 100).toFixed(1);
      console.error(`  ${t}: ${before.toLocaleString()} → ${after.toLocaleString()} (${delta > 0 ? "+" : ""}${pct}%)`);
    }
  }
  console.error(`recorded in ${RECORD}. Run --write to re-render the docs.`);
}

function cmdWrite() {
  const rec = loadRecord();
  const changed = replaceBlock(join(REPO, "docs", "frontend.md"), renderTables(rec));
  console.error(changed ? "docs/frontend.md updated." : "docs/frontend.md already current.");
  const problems = checkProse(rec);
  if (problems.length) {
    console.error("\nProse ranges still need a human (they are sentences, not tables):");
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
}

function cmdCheck({ measure, strict, measureTargetName = "desktop" }) {
  const key = TARGETS[measureTargetName].key();
  const rec = loadRecord();
  const problems = [];
  const version = janelaVersion();

  // 1. the generated block matches the record
  const file = join(REPO, "docs", "frontend.md");
  const want = renderTables(rec);
  const text = readText(file);
  const a = text.indexOf(MARK_START);
  const b = text.indexOf(MARK_END);
  if (a === -1 || b === -1) problems.push(`docs/frontend.md has no generated sizes block`);
  else if (text.slice(a, b + MARK_END.length) !== want) {
    problems.push(`docs/frontend.md's table does not match docs/sizes.json — run --write`);
  }

  // 2. prose ranges still bracket the measurements
  problems.push(...checkProse(rec));

  // 3. every platform's figures were taken at the current version.
  //
  // A lagging column this host can measure is a failure — the fix is one
  // command. A lagging column that needs a simulator or an emulator is a
  // warning: failing CI over a number no CI runner can produce would only
  // teach people to ignore this check. --strict promotes them, for the
  // release checklist.
  const warnings = [];
  const can = measurable();
  const targetOf = Object.fromEntries(Object.entries(TARGETS).map(([n, t]) => [t.key(), n]));
  for (const [k, p] of Object.entries(rec.platforms)) {
    if (p.janela === version) continue;
    const msg = `${k}: figures were measured at janela ${p.janela}, the package is now ${version}.`;
    const name = targetOf[k];
    if (name && can[name] === true) {
      problems.push(
        `${msg} Re-measure: node scripts/measure-sizes.mjs --measure` +
          (name === "desktop" ? "" : ` --target ${name}`),
      );
    } else {
      warnings.push(`${msg} Not measurable here: ${name ? can[name] : "unknown platform"}.`);
    }
  }

  // 4. optionally re-measure this host and compare
  if (measure) {
    if (!rec.platforms[key]) {
      problems.push(`no recorded figures for ${key} — run --measure`);
    } else {
      const { sizes } = measureAll(measureTargetName);
      for (const [t, bytes] of Object.entries(sizes)) {
        const was = rec.platforms[key].sizes[t];
        if (was == null) problems.push(`${key}/${t}: not in the record`);
        else if (was !== bytes) {
          problems.push(
            `${key}/${t}: builds at ${bytes.toLocaleString()} B, recorded ${was.toLocaleString()} B ` +
              `(${bytes > was ? "+" : ""}${(((bytes - was) / was) * 100).toFixed(1)}%)`,
          );
        }
      }
    }
  } else {
    const names = Object.entries(TARGETS)
      .filter(([, t]) => rec.platforms[t.key()])
      .map(([n, t]) => `${t.key()} (--target ${n})`);
    console.error(
      `checked the published figures against ${RECORD}.\n` +
        `  No builds run. To re-measure a column: ${names.join(", ")}.`,
    );
  }

  if (warnings.length) {
    console.error(`\nmeasure-sizes: ${warnings.length} warning(s):`);
    for (const w of warnings) console.error(`  - ${w}`);
  }
  if (problems.length || (strict && warnings.length)) {
    const all = [...problems, ...(strict ? warnings : [])];
    console.error(`\nmeasure-sizes: ${all.length} problem(s):`);
    for (const p of all) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.error("measure-sizes: published sizes are consistent.");
}

const argv = process.argv.slice(2);
const known = ["--measure", "--write", "--check", "--strict", "--target", "--help", "-h"];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--target") {
    const v = argv[++i];
    if (!v || !TARGETS[v]) die(`--target needs one of: ${Object.keys(TARGETS).join(", ")}`);
    continue;
  }
  if (!known.includes(a)) die(`unknown option '${a}'. Known: ${known.join(", ")}`);
}
const ti = argv.indexOf("--target");
const target = ti === -1 ? "desktop" : argv[ti + 1];

if (argv.includes("--help") || argv.includes("-h") || argv.length === 0) {
  console.error(readText(fileURLToPath(import.meta.url)).split("\n").slice(1, 21).join("\n").replace(/^\/\/ ?/gm, ""));
  process.exit(argv.length === 0 ? 1 : 0);
}
const strict = argv.includes("--strict");
if (argv.includes("--measure") && argv.includes("--check")) {
  cmdCheck({ measure: true, strict, measureTargetName: target });
} else if (argv.includes("--measure")) {
  cmdMeasure(target);
  cmdWrite();
} else if (argv.includes("--write")) cmdWrite();
else if (argv.includes("--check")) cmdCheck({ measure: false, strict });
