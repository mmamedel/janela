// Scaffolding a fixture project: create it with the real CLI, then replace
// both sides with the fixture's own host and page.
//
// The fixture owns its host commands rather than reusing the template's,
// because templates have changed shape repeatedly and a suite that leans on
// them fails for the wrong reason. Its contract is a superset of the
// template's, so the framework page still type-checks and renders.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, "..", "..", "..");
export const CLI = join(REPO, "packages", "janela", "bin", "janela.mjs");
const FIXTURE = resolve(HERE, "..", "fixture");

/** Everything the suite writes lives here, and it is gitignored. */
export function scratchRoot() {
  return process.env.JANELA_TEST_SCRATCH
    ? resolve(process.env.JANELA_TEST_SCRATCH)
    : join(REPO, ".janela-tests");
}

export function cli(args, opts = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    cwd: opts.cwd ?? scratchRoot(),
    env: { ...process.env, ...(opts.env ?? {}) },
    timeout: opts.timeoutMs ?? 15 * 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
}

function patchIndexHtml(projectDir, pageScript, config) {
  const file = join(projectDir, "index.html");
  const before = readFileSync(file, "utf8");
  const injected =
    `<script>window.__JANELA_TEST_CONFIG = ${JSON.stringify(config)};</script>\n` +
    `<script>\n${readFileSync(join(FIXTURE, pageScript), "utf8")}\n</script>\n`;

  let after;
  if (before.includes("</body>")) {
    after = before.replace("</body>", `${injected}</body>`);
  } else {
    after = `${before}\n${injected}`;
  }
  writeFileSync(file, after, "utf8");

  // Assert the edit actually applied. A silently no-op'd fixture edit, plus a
  // grep over empty output, is exactly how this project has produced false
  // passes before.
  const written = readFileSync(file, "utf8");
  if (!written.includes("__JANELA_TEST_CONFIG") || written === before) {
    throw new Error(`fixture edit did not apply to ${file}`);
  }
  return file;
}

/**
 * Scaffold a project, install deps if the template needs them, and wire in
 * the fixture. Returns { dir, name, config }.
 */
export function prepareProject({ template = "vanilla", name, page = "battery.js", bigMb }) {
  const root = scratchRoot();
  mkdirSync(root, { recursive: true });
  const dir = join(root, name);
  rmSync(dir, { recursive: true, force: true });

  const args = ["init", name];
  if (template !== "vanilla") args.push("--template", template);
  const made = cli(args);
  if (made.status !== 0) {
    throw new Error(`janela init failed (${made.status}):\n${made.stdout}\n${made.stderr}`);
  }
  if (!existsSync(dir)) throw new Error(`janela init reported success but ${dir} is missing`);

  // The framework templates need their own dependencies.
  if (existsSync(join(dir, "package.json")) && template !== "vanilla") {
    // `npm` is a .cmd shim on Windows, and Node no longer resolves those from
    // spawnSync without a shell — naming it explicitly keeps this shell-free.
    const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";
    const npm = spawnSync(npmBin, ["install", "--silent", "--no-audit", "--no-fund"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 15 * 60_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (npm.status !== 0) {
      throw new Error(`${npmBin} install failed in ${dir}:\n${npm.stdout}\n${npm.stderr}`);
    }
  }

  // Replace the host with the fixture's superset contract.
  const hostFile = join(dir, "src-host", "main.ts");
  mkdirSync(dirname(hostFile), { recursive: true });
  writeFileSync(hostFile, readFileSync(join(FIXTURE, "host.ts"), "utf8"), "utf8");
  if (!readFileSync(hostFile, "utf8").includes("sleepOrder")) {
    throw new Error("fixture host did not land");
  }

  // Paths are RELATIVE on purpose. Desktop runs with the project as its cwd;
  // the mobile shells map a relative path into the app's own container. An
  // absolute host path exists on neither phone, which is exactly how this
  // fixture first failed on Android.
  const megabytes = bigMb ?? Number(process.env.JANELA_TEST_BIG_MB ?? 32);
  // Every reported line carries this, and the parser accepts nothing else:
  // the device lanes read a log over a time window and would otherwise parse
  // a previous run's results.
  const runId = `${name}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  const config = {
    runId,
    scratchFile: "roundtrip.txt",
    missingFile: "definitely/not/here.txt",
    scratchDir: ".",
    bigFile: "big.txt",
    // The app writes this file itself before reading it, so the large-read
    // assertions need nothing staged from outside and behave identically on
    // every lane.
    bigBytes: megabytes * 1024 * 1024,
    framework: template !== "vanilla",
    asyncMs: Number(process.env.JANELA_TEST_ASYNC_MS ?? 300),
    syncLatencyMaxMs: Number(process.env.JANELA_TEST_SYNC_MAX_MS ?? 150),
    drainP99MaxMs: Number(process.env.JANELA_TEST_DRAIN_P99_MAX_MS ?? 50),
  };

  patchIndexHtml(dir, page, config);
  return { dir, name, config, template };
}

export function build(dir, target) {
  const args = ["build"];
  if (target) args.push("--target", target);
  const out = cli(args, { cwd: dir });
  if (out.status !== 0) {
    throw new Error(`janela build${target ? ` --target ${target}` : ""} failed:\n${out.stdout}\n${out.stderr}`);
  }
  return out.stdout;
}

export function cleanup(dir) {
  if (!process.env.JANELA_TEST_KEEP) rmSync(dir, { recursive: true, force: true });
}

export { execFileSync };
