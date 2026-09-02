// Lane adapters. Each one builds for its target, runs the app, and returns
// the app's output as text — so the assertions and the result parsing are
// shared verbatim across desktop, iOS and Android.
//
// Host `console.log` reaches:
//   desktop  stdout
//   iOS      os_log, subsystem dev.janela, category host
//   Android  logcat, tag janela-host
// Only desktop can run in CI; the mobile lanes need a booted simulator or
// emulator, so they are opt-in and skipped by default.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "./project.mjs";

const BIG_BUFFER = { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 };

/**
 * The device lanes read a log over a time window, so they must wait for the
 * marker belonging to THIS run. Matching a bare JANELA_TEST_DONE snapshots the
 * log while the current run is still starting and reports the previous run's
 * results — which this harness did until the run id was threaded through.
 */
function finishedRe(project) {
  const id = project.config.runId;
  if (!id) throw new Error("lane needs project.config.runId");
  return new RegExp(`JANELA_TEST_(?:DONE|WORK_STARTED)[^\n]*${id}`);
}

function conf(dir) {
  return JSON.parse(readFileSync(join(dir, "janela.conf.json"), "utf8"));
}

/** Mirror of the CLI's androidPackage(): an application id is a Java package. */
function androidPackage(id) {
  return id
    .split(".")
    .map((seg) => seg.replace(/[^A-Za-z0-9_]/g, "_"))
    .join(".");
}

export const DESKTOP = {
  name: "desktop",
  available: () => true,
  run(project) {
    build(project.dir);
    const c = conf(project.dir);
    const exe = join(project.dir, ".janela", "out", process.platform === "win32" ? `${c.name}.exe` : c.name);
    if (!existsSync(exe)) throw new Error(`built binary missing: ${exe}`);

    // Linux CI has no display; xvfb-run supplies one.
    const useXvfb = process.platform === "linux" && !process.env.DISPLAY;
    const cmd = useXvfb ? "xvfb-run" : exe;
    const args = useXvfb ? ["-a", exe] : [];
    const out = spawnSync(cmd, args, {
      ...BIG_BUFFER,
      cwd: project.dir,
      timeout: Number(process.env.JANELA_TEST_RUN_TIMEOUT_MS ?? 300_000),
    });
    return {
      output: `${out.stdout ?? ""}\n${out.stderr ?? ""}`,
      exitCode: out.status,
      signal: out.signal,
    };
  },
};

export const IOS = {
  name: "ios",
  available: () => {
    if (process.platform !== "darwin") return false;
    const l = spawnSync("xcrun", ["simctl", "list", "devices", "booted"], BIG_BUFFER);
    return l.status === 0 && /\(Booted\)/.test(l.stdout ?? "");
  },
  run(project) {
    build(project.dir, "ios");
    const c = conf(project.dir);
    const bundle = join(project.dir, ".janela", "out-ios", `${c.name}.app`);
    if (!existsSync(bundle)) throw new Error(`built bundle missing: ${bundle}`);

    const booted = spawnSync("xcrun", ["simctl", "list", "devices", "booted"], BIG_BUFFER).stdout;
    const udid = /\(([0-9A-F-]{36})\) \(Booted\)/.exec(booted ?? "")?.[1];
    if (!udid) throw new Error("no booted simulator");
    const bundleId = c.ios?.identifier ?? c.identifier;

    spawnSync("xcrun", ["simctl", "terminate", udid, bundleId], BIG_BUFFER);
    const inst = spawnSync("xcrun", ["simctl", "install", udid, bundle], BIG_BUFFER);
    if (inst.status !== 0) throw new Error(`simctl install failed: ${inst.stderr}`);
    const started = Date.now();
    const launch = spawnSync("xcrun", ["simctl", "launch", udid, bundleId], BIG_BUFFER);
    if (launch.status !== 0) throw new Error(`simctl launch failed: ${launch.stderr}`);

    // The app quits itself; poll the log until DONE shows up or we time out.
    const budget = Number(process.env.JANELA_TEST_RUN_TIMEOUT_MS ?? 300_000);
    const done = finishedRe(project);
    let output = "";
    while (Date.now() - started < budget) {
      const log = spawnSync(
        "xcrun",
        ["simctl", "spawn", udid, "log", "show", "--last", "10m", "--style", "compact",
         "--predicate", `subsystem == "dev.janela"`],
        BIG_BUFFER,
      );
      output = log.stdout ?? "";
      if (done.test(output)) break;
      spawnSync("sleep", ["2"]);
    }
    // The simulator app's exit code is not observable this way; the suite
    // judges the run on the assertions, which is the stronger signal anyway.
    return { output, exitCode: 0, signal: null };
  },
};

export const ANDROID = {
  name: "android",
  available: () => {
    const home = process.env.ANDROID_HOME ?? join(process.env.HOME ?? "", "Library/Android/sdk");
    const adb = join(home, "platform-tools", "adb");
    if (!existsSync(adb)) return false;
    const d = spawnSync(adb, ["devices"], BIG_BUFFER);
    return d.status === 0 && /\bdevice\s*$/m.test(d.stdout ?? "");
  },
  run(project) {
    build(project.dir, "android");
    const c = conf(project.dir);
    const apk = join(project.dir, ".janela", "out-android", `${c.name}.apk`);
    if (!existsSync(apk)) throw new Error(`built apk missing: ${apk}`);

    const home = process.env.ANDROID_HOME ?? join(process.env.HOME ?? "", "Library/Android/sdk");
    const adb = join(home, "platform-tools", "adb");
    const appId = androidPackage(c.android?.applicationId ?? c.android?.identifier ?? c.identifier);

    spawnSync(adb, ["uninstall", appId], BIG_BUFFER);
    const inst = spawnSync(adb, ["install", "-r", apk], BIG_BUFFER);
    if (inst.status !== 0) throw new Error(`adb install failed: ${inst.stdout}${inst.stderr}`);
    spawnSync(adb, ["logcat", "-c"], BIG_BUFFER);
    const start = spawnSync(
      adb,
      ["shell", "am", "start", "-W", "-n", `${appId}/dev.janela.host.JanelaActivity`],
      BIG_BUFFER,
    );
    if (start.status !== 0) throw new Error(`am start failed: ${start.stdout}${start.stderr}`);

    const budget = Number(process.env.JANELA_TEST_RUN_TIMEOUT_MS ?? 300_000);
    const started = Date.now();
    const done = finishedRe(project);
    let output = "";
    while (Date.now() - started < budget) {
      const log = spawnSync(adb, ["logcat", "-d", "-s", "janela-host:V"], BIG_BUFFER);
      output = log.stdout ?? "";
      if (done.test(output)) break;
      spawnSync("sleep", ["2"]);
    }
    return { output, exitCode: 0, signal: null };
  },
};

export const LANES = { desktop: DESKTOP, ios: IOS, android: ANDROID };

/** Which lanes to exercise: desktop unless JANELA_TEST_LANES says otherwise. */
export function selectedLanes() {
  const raw = process.env.JANELA_TEST_LANES ?? "desktop";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((n) => {
      const lane = LANES[n];
      if (!lane) throw new Error(`unknown lane '${n}' (have: ${Object.keys(LANES).join(", ")})`);
      return lane;
    });
}

/** Which templates to exercise: vanilla + vue unless overridden. */
export function selectedTemplates() {
  const raw = process.env.JANELA_TEST_TEMPLATES ?? "vanilla,vue";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
