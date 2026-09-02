#!/usr/bin/env node
// janela — the CLI (the tauri-cli analogue).
//
//   janela init <name>   scaffold a new project
//   janela build         compile the project to a native binary (+ .app on macOS)
//   janela dev           build, then run the binary with logs in the terminal
//
// A project is: index.html (frontend), src-host/main.ts (commands),
// janela.conf.json (window + bundle config). Everything else — the C shim over
// webview.h, the vendored webview, the scriptc runtime library, the FFI
// manifest — lives in this package and is assembled into .janela/ at build time.

import { spawn, spawnSync } from "node:child_process";
import {
  cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ANDROID_ABI, ANDROID_TARGET_SDK, androidConf, ffiManifest, iosConf,
  libraryProfile, mimeFor, NAME_RE, patchPeSubsystem, PeError,
  rewriteHostSpecifier, suggestName,
} from "./lib.mjs";

const KIT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(KIT, "package.json"));

function fail(msg) {
  console.error(`janela: ${msg}`);
  process.exit(1);
}

function run(argv, opts = {}) {
  const r = spawnSync(argv[0], argv.slice(1), { stdio: "inherit", ...opts });
  if (r.status !== 0) fail(`command failed (${r.status ?? r.error}): ${argv.join(" ")}`);
}

function capture(argv) {
  const r = spawnSync(argv[0], argv.slice(1), { encoding: "utf8" });
  if (r.status !== 0) fail(`command failed: ${argv.join(" ")}`);
  return r.stdout.trim();
}

function scriptcBin() {
  const pkg = require.resolve("scriptc/package.json");
  const meta = JSON.parse(readFileSync(pkg, "utf8"));
  const rel = typeof meta.bin === "string" ? meta.bin : meta.bin.scriptc;
  return join(dirname(pkg), rel);
}

function loadConf(root) {
  const p = join(root, "janela.conf.json");
  if (!existsSync(p)) fail("no janela.conf.json here — run from a project root (or `janela init <name>`)");
  const c = JSON.parse(readFileSync(p, "utf8"));
  for (const k of ["name", "identifier", "window"]) {
    if (!c[k]) fail(`janela.conf.json is missing '${k}'`);
  }
  return c;
}

// ---- frontend: plain HTML, or a Vite app -----------------------------------
//
// A project is in "Vite mode" when it has a vite config at its root; otherwise
// index.html is inlined verbatim, exactly as janela has always done.
//
// There is no file server behind the window: the shim hands the webview one
// HTML document (webview_set_html). So a Vite build is flattened into that one
// document — JS inlined as a module script, CSS as a <style>, everything else
// as a data: URI. The alternative designs (embedding the dist tree and serving
// it from a localhost HTTP server in the shim, or registering a custom URI
// scheme per platform) each cost a platform-specific implementation in C++ and
// buy nothing until an app outgrows a single document.

const VITE_CONFIGS = [
  "vite.config.js", "vite.config.ts", "vite.config.mjs",
  "vite.config.mts", "vite.config.cjs", "vite.config.cts",
];

function viteConfigPath(root) {
  for (const f of VITE_CONFIGS) {
    const p = join(root, f);
    if (existsSync(p)) return p;
  }
  return null;
}

// How to run the project's own vite.
//
// The `.bin` entry is a .cmd shim on Windows and, since the CVE-2024-27980
// fix, Node refuses to spawn a .cmd without a shell. `janela dev` passed
// `shell: true` and worked; `janela build` did not, so building any Vite
// template on Windows died with `spawnSync ...\vite.cmd EINVAL`. Prefer
// vite's own JS entry run with this Node: no shim, no shell, and identical on
// every platform. The shim stays as a fallback for layouts that hide the
// package but keep the bin.
function viteCommand(root) {
  const js = join(root, "node_modules", "vite", "bin", "vite.js");
  if (existsSync(js)) return { argv: [process.execPath, js], shell: false };

  const shim = join(root, "node_modules", ".bin", process.platform === "win32" ? "vite.cmd" : "vite");
  if (existsSync(shim)) return { argv: [shim], shell: process.platform === "win32" };

  fail(
    "this project has a vite config but no local vite — run your package manager's " +
      "install first (npm install / pnpm install)",
  );
}


// A dist-relative reference ("/assets/x.js", "./assets/x.js") → absolute path,
// or null when it points outside the build (a CDN URL, a data: URI, an anchor).
function distAsset(distDir, ref) {
  if (!ref || /^(https?:|data:|blob:|#|mailto:)/i.test(ref)) return null;
  const clean = ref.split("?")[0].split("#")[0].replace(/^\.?\//, "");
  if (!clean) return null;
  const p = join(distDir, clean);
  return existsSync(p) && statSync(p).isFile() ? p : null;
}

function dataUri(file) {
  return `data:${mimeFor(file)};base64,${readFileSync(file).toString("base64")}`;
}

function attr(tag, name) {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i"));
  return m ? m[1] : null;
}

// url(...) inside CSS → data: URIs, so a stylesheet's images and fonts survive
// the flattening too.
function inlineCssUrls(css, distDir, cssFile) {
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (whole, _q, ref) => {
    const rel = ref.startsWith("/")
      ? distAsset(distDir, ref)
      : distAsset(distDir, relative(distDir, join(dirname(cssFile), ref)));
    return rel ? `url("${dataUri(rel)}")` : whole;
  });
}

// Flatten dist/ into one self-contained HTML document.
function inlineDist(distDir) {
  const htmlPath = join(distDir, "index.html");
  if (!existsSync(htmlPath)) fail(`vite build produced no ${relative(process.cwd(), htmlPath)}`);
  let html = readFileSync(htmlPath, "utf8");

  // Preloads only matter when there are separate files to fetch.
  html = html.replace(/<link\b[^>]*\brel\s*=\s*["'](?:modulepreload|preload|prefetch)["'][^>]*>\s*/gi, "");

  html = html.replace(/<script\b([^>]*)><\/script>/gi, (whole, attrs) => {
    const file = distAsset(distDir, attr(attrs, "src"));
    if (!file) return whole;
    const type = /\btype\s*=\s*["']module["']/i.test(attrs) ? ' type="module"' : "";
    // A literal </script> inside the code would close this tag early.
    const js = readFileSync(file, "utf8").replace(/<\/script/gi, "<\\/script");
    return `<script${type}>${js}</script>`;
  });

  html = html.replace(/<link\b([^>]*)>/gi, (whole, attrs) => {
    const href = attr(attrs, "href");
    const file = distAsset(distDir, href);
    if (!file) return whole;
    if (/\brel\s*=\s*["']stylesheet["']/i.test(attrs)) {
      const css = inlineCssUrls(readFileSync(file, "utf8"), distDir, file).replace(/<\/style/gi, "<\\/style");
      return `<style>${css}</style>`;
    }
    return whole.replace(href, dataUri(file));
  });

  // Anything still pointing at a file in dist (favicons, <img>, <source>).
  html = html.replace(/\b(src|href)\s*=\s*["']([^"']+)["']/gi, (whole, name, ref) => {
    const file = distAsset(distDir, ref);
    return file ? `${name}="${dataUri(file)}"` : whole;
  });

  return html;
}

// The document handed to the webview. In dev mode it is a stub that hands the
// window over to the Vite server: location.replace leaves no history entry, and
// the janela bootstrap is injected per-document (webview_init), so the served
// page gets window.janela exactly like an inlined one.
function frontendHtml(root, conf, devUrl) {
  if (devUrl) {
    return `<!doctype html><html><head><meta charset="utf-8"><title>${conf.name}</title></head>` +
      `<body><script>location.replace(${JSON.stringify(devUrl)});</script></body></html>`;
  }

  if (viteConfigPath(root)) {
    console.log("janela: building the frontend with vite");
    const viteCmd = viteCommand(root);
    run([...viteCmd.argv, "build"], { cwd: root, shell: viteCmd.shell });
    const distDir = resolve(root, conf.frontend?.dist ?? "dist");
    const html = inlineDist(distDir);
    console.log(`janela: frontend inlined (${(Buffer.byteLength(html) / 1024).toFixed(0)} kB)`);
    return html;
  }

  const htmlSrc = join(root, "index.html");
  if (!existsSync(htmlSrc)) fail("missing index.html");
  return readFileSync(htmlSrc, "utf8");
}

// ---- Windows toolchain ------------------------------------------------------

// scriptc's win32 lane is MinGW-shaped twice over: its runtime uses POSIX
// types the MSVC CRT lacks (ssize_t), and its event loop calls POSIX time
// APIs that only a full mingw-w64 provides ("the idle sleep is nanosleep
// (mingw-w64 ships it, over Sleep)" — scr_async.c). So Windows builds need a
// clang whose DEFAULT target is mingw: llvm-mingw, MSYS2's clang64, or
// WinLibs. A stock MSVC-targeting clang cannot compile scriptc's runtime, and
// zig's bundled mingw omits winpthreads, so it cannot either.
function winCcOrFail() {
  const probe = spawnSync("clang", ["-dumpmachine"], { encoding: "utf8" });
  if (probe.status !== 0) {
    fail(
      "Windows builds need a MinGW-targeting clang on PATH. Install llvm-mingw " +
        "(https://github.com/mstorsjo/llvm-mingw/releases) or MSYS2's clang64 toolchain.",
    );
  }
  const triple = probe.stdout.trim();
  if (!/mingw|windows-gnu/i.test(triple)) {
    fail(
      `clang on PATH targets '${triple}', but scriptc's Windows runtime only builds with ` +
        "MinGW (it uses ssize_t/nanosleep/clock_gettime, which the MSVC CRT lacks). " +
        "Put a MinGW-targeting clang first on PATH — llvm-mingw " +
        "(https://github.com/mstorsjo/llvm-mingw/releases) or MSYS2's clang64.",
    );
  }
  return triple;
}

// ---- WebView2 SDK (Windows only) -------------------------------------------

// webview.h's Win32 backend includes <WebView2.h>, which ships in Microsoft's
// nuget package rather than the Windows SDK. Fetch it once into the build
// cache (a .nupkg is a zip) unless the caller points at their own copy.
const WEBVIEW2_VERSION = "1.0.2903.40";

function webview2Include(cacheDir) {
  const override = process.env.JANELA_WEBVIEW2_INCLUDE;
  if (override) {
    if (!existsSync(join(override, "WebView2.h"))) {
      fail(`JANELA_WEBVIEW2_INCLUDE=${override} does not contain WebView2.h`);
    }
    return override;
  }

  const sdkDir = join(cacheDir, `webview2-${WEBVIEW2_VERSION}`);
  const incDir = join(sdkDir, "build", "native", "include");
  if (existsSync(join(incDir, "WebView2.h"))) return incDir;

  console.log(`janela: fetching WebView2 SDK ${WEBVIEW2_VERSION}`);
  const zip = join(cacheDir, `webview2-${WEBVIEW2_VERSION}.zip`);
  const url = `https://www.nuget.org/api/v2/package/Microsoft.Web.WebView2/${WEBVIEW2_VERSION}`;
  run([
    "powershell", "-NoProfile", "-NonInteractive", "-Command",
    `$ErrorActionPreference='Stop';` +
      `[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12;` +
      `Invoke-WebRequest -Uri '${url}' -OutFile '${zip}';` +
      `Expand-Archive -Path '${zip}' -DestinationPath '${sdkDir}' -Force`,
  ]);
  if (!existsSync(join(incDir, "WebView2.h"))) {
    fail(`WebView2 SDK unpacked to ${sdkDir} but no build/native/include/WebView2.h`);
  }
  return incDir;
}

// ---- iOS ------------------------------------------------------------------
//
// The second build lane. Desktop compiles TypeScript to an EXECUTABLE that
// drives a C library over FFI; iOS compiles it to a LIBRARY that a UIKit shell
// drives. scriptc refuses executables for iOS targets, so the inversion is not
// a preference — and library mode links no event loop (SC4005), which is why
// the async surface is desktop-only there.
//
// Everything below is simulator-only: a device build additionally needs a
// signing identity and a provisioning profile, which is its own project.


function iosDeviceOrFail(name) {
  const json = capture(["xcrun", "simctl", "list", "devices", "available", "--json"]);
  const devices = JSON.parse(json).devices ?? {};
  const runtimes = Object.keys(devices).filter((k) => /iOS/i.test(k));
  if (runtimes.length === 0) {
    fail(
      "no iOS simulator runtime is installed — open Xcode > Settings > Components " +
        "and get an iOS simulator, or run `xcodebuild -downloadPlatform iOS` in a terminal " +
        "(it needs admin rights, so it cannot run unattended)",
    );
  }
  const all = runtimes.flatMap((k) => devices[k]);
  const pick = name
    ? all.find((d) => d.name === name)
    : all.find((d) => /^iPhone/.test(d.name)) ?? all[0];
  if (!pick) fail(`no simulator named '${name}' — see \`xcrun simctl list devices\``);
  return pick;
}

// The library profile: one export carries every command, so a project's own
// commands need no ABI of their own. `janelaEmit` is the reverse channel the
// shell registers before init.
function iosPlist(conf, iconFiles = []) {
  const ios = iosConf(conf);
  // The asset-catalogue route needs actool; the CFBundleIconFiles list is the
  // older mechanism and keeps this hand-assembled bundle toolchain-free.
  const icons = iconFiles.length
    ? `\n  <key>CFBundleIconFiles</key><array>${iconFiles
        .map((f) => `<string>${f}</string>`)
        .join("")}</array>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>${conf.name}</string>
  <key>CFBundleDisplayName</key><string>${ios.displayName}</string>
  <key>CFBundleIdentifier</key><string>${ios.identifier}</string>
  <key>CFBundleExecutable</key><string>${conf.name}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>${conf.version ?? "0.1.0"}</string>
  <key>CFBundleShortVersionString</key><string>${conf.version ?? "0.1.0"}</string>
  <key>LSRequiresIPhoneOS</key><true/>
  <key>UILaunchScreen</key><dict/>
  <key>MinimumOSVersion</key><string>${ios.minimumVersion}</string>
  <key>CFBundleSupportedPlatforms</key><array><string>iPhoneSimulator</string></array>${icons}
</dict>
</plist>
`;
}

function buildIos(root, conf, buildDir, outDir) {
  if (process.platform !== "darwin") {
    fail("iOS builds need macOS with Xcode — `--target ios` is only available there");
  }
  if (!which("zig")) {
    fail(
      "iOS builds need zig on PATH: scriptc routes mobile targets through `zig cc`. " +
        "Install it with `brew install zig`",
    );
  }
  const ios = iosConf(conf);

  writeFileSync(join(buildDir, "profile.json"), JSON.stringify(libraryProfile(), null, 2) + "\n");

  console.log("janela: compiling TypeScript to an iOS library");
  run(["node", scriptcBin(), "build", "--lib", "--profile", "profile.json"], {
    cwd: buildDir,
    env: {
      ...process.env,
      SCRIPTC_CC: "zigcc",
      SCRIPTC_TARGET: "aarch64-apple-ios-simulator",
    },
  });
  const lib = join(buildDir, ".scriptc", "entry.lib.a");
  if (!existsSync(lib)) fail(`scriptc produced no library at ${lib}`);

  console.log("janela: compiling the UIKit shell");
  const bundle = join(outDir, `${conf.name}.app`);
  mkdirSync(bundle, { recursive: true });
  const sdk = capture(["xcrun", "--sdk", "iphonesimulator", "--show-sdk-path"]);
  // Plain C++: the shell drives the webview through webview.h's UIKit
  // backend, which uses the Objective-C runtime rather than Objective-C, so
  // no .mm and no -fobjc-arc. Blocks still need -fblocks for libdispatch.
  run([
    "xcrun", "clang++",
    join(KIT, "shim", "ios", "app.cc"),
    "-target", `arm64-apple-ios${ios.minimumVersion}-simulator`,
    "-isysroot", sdk,
    "-std=c++17", "-O2", "-fblocks",
    `-I${join(KIT, "vendor-webview", "core", "include")}`,
    "-framework", "UIKit", "-framework", "WebKit", "-framework", "Foundation",
    lib,
    "-o", join(bundle, conf.name),
  ]);
  run(["strip", join(bundle, conf.name)]);

  const icon = iconSource(root, conf);
  let iconFiles = [];
  if (icon) {
    iconFiles = makeIosIcons(icon, bundle);
    if (!iconFiles.length) {
      console.warn("janela: could not generate iOS icons (sips unavailable) — building without one");
    }
  }
  writeFileSync(join(bundle, "Info.plist"), iosPlist(conf, iconFiles));

  console.log(
    `janela: built ${relative(root, bundle)} ` +
      `(${statSync(join(bundle, conf.name)).size} bytes, iOS Simulator)`,
  );
  return bundle;
}

async function devIos(root) {
  const conf = loadConf(root);
  const device = iosDeviceOrFail(iosConf(conf).device);
  const bundle = build(root, { target: "ios" });

  if (device.state !== "Booted") {
    console.log(`janela: booting ${device.name}`);
    spawnSync("xcrun", ["simctl", "boot", device.udid]);
    spawnSync("xcrun", ["simctl", "bootstatus", device.udid, "-b"]);
  }
  spawnSync("open", ["-a", "Simulator"]);

  console.log(`janela: installing on ${device.name}`);
  run(["xcrun", "simctl", "install", device.udid, bundle]);
  console.log("janela: launching (Ctrl-C to stop following the log)");
  run([
    "xcrun", "simctl", "launch", "--console-pty",
    device.udid, iosConf(conf).identifier,
  ]);
}


// ---- Android ---------------------------------------------------------------
//
// Android is library-mode like iOS: the system owns the Activity and its
// Looper, and the app's TypeScript is a linked scriptc library the shell calls
// into. Unlike every other target the APK also carries Java — the webview
// backend needs a companion class because android.webkit.WebView is a Java API
// and native code cannot define a class to receive its callbacks.


/// Android package names are Java package names: dot-separated identifiers,
/// so no hyphens. A janela project may be called `my-app`, which makes the
/// default identifier `dev.janela.my-app` — legal everywhere else and not
/// here, so each segment is coerced rather than failing the build.
/// The SDK pieces an Android build needs, or a message saying which is absent.
function androidSdk() {
  const home =
    process.env.ANDROID_HOME ??
    process.env.ANDROID_SDK_ROOT ??
    join(process.env.HOME ?? "", "Library", "Android", "sdk");
  if (!existsSync(home)) {
    fail(
      "Android builds need the Android SDK. Install it (Android Studio, or " +
        "`sdkmanager`) and set ANDROID_HOME",
    );
  }
  const ndkRoot = process.env.ANDROID_NDK_ROOT ?? null;
  const ndks = existsSync(join(home, "ndk"))
    ? readdirSync(join(home, "ndk")).sort()
    : [];
  const ndk = ndkRoot ?? (ndks.length ? join(home, "ndk", ndks[ndks.length - 1]) : null);
  if (!ndk || !existsSync(ndk)) {
    fail(
      "Android builds need the NDK: `sdkmanager --install 'ndk;27.0.12077973'`, " +
        "or set ANDROID_NDK_ROOT",
    );
  }
  const buildToolsDir = join(home, "build-tools");
  const versions = existsSync(buildToolsDir) ? readdirSync(buildToolsDir).sort() : [];
  if (!versions.length) fail("Android builds need build-tools: `sdkmanager --install 'build-tools;36.0.0'`");
  const bt = join(buildToolsDir, versions[versions.length - 1]);

  const platformsDir = join(home, "platforms");
  const platforms = existsSync(platformsDir) ? readdirSync(platformsDir).sort() : [];
  if (!platforms.length) fail("Android builds need a platform: `sdkmanager --install 'platforms;android-36'`");
  const androidJar = join(platformsDir, platforms[platforms.length - 1], "android.jar");

  // The NDK ships darwin-x86_64 host binaries even on Apple silicon.
  const hosts = readdirSync(join(ndk, "toolchains", "llvm", "prebuilt"));
  const toolchain = join(ndk, "toolchains", "llvm", "prebuilt", hosts[0], "bin");

  return { home, ndk, bt, androidJar, toolchain, adb: join(home, "platform-tools", "adb") };
}

function javaHome() {
  if (process.env.JAVA_HOME) return process.env.JAVA_HOME;
  const brew = "/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home";
  if (existsSync(brew)) return brew;
  fail("Android builds need a JDK. Install one (`brew install openjdk`) and set JAVA_HOME");
}

function androidManifest(conf, { icon = false } = {}) {
  const a = androidConf(conf);
  const iconAttr = icon ? ` android:icon="@mipmap/ic_launcher"` : "";
  return `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="${a.applicationId}"
    android:versionCode="1"
    android:versionName="${conf.version ?? "0.1.0"}">
  <uses-permission android:name="android.permission.INTERNET"/>
  <application android:label="${a.label}"${iconAttr} android:hasCode="true">
    <activity android:name="dev.janela.host.JanelaActivity" android:exported="true">
      <intent-filter>
        <action android:name="android.intent.action.MAIN"/>
        <category android:name="android.intent.category.LAUNCHER"/>
      </intent-filter>
    </activity>
  </application>
</manifest>
`;
}

/// A debug keystore, generated once and cached. Android refuses to install an
/// unsigned APK; a debug key is enough for a simulator or a developer device.
function debugKeystore(cacheDir, jdk) {
  const ks = join(cacheDir, "debug.keystore");
  if (existsSync(ks)) return ks;
  run([
    join(jdk, "bin", "keytool"), "-genkeypair", "-keystore", ks,
    "-storepass", "android", "-keypass", "android", "-alias", "androiddebugkey",
    "-dname", "CN=Android Debug,O=janela,C=US",
    "-keyalg", "RSA", "-keysize", "2048", "-validity", "10000",
  ]);
  return ks;
}

function buildAndroid(root, conf, buildDir, outDir) {
  const sdk = androidSdk();
  const jdk = javaHome();
  if (!which("zig")) {
    fail(
      "Android builds need zig on PATH: scriptc routes mobile targets through " +
        "`zig cc`. Install it with `brew install zig`",
    );
  }
  const a = androidConf(conf);
  const cacheDir = join(root, ".janela", "cache");

  writeFileSync(join(buildDir, "profile.json"), JSON.stringify(libraryProfile(), null, 2) + "\n");

  console.log("janela: compiling TypeScript to an Android library");
  run(["node", scriptcBin(), "build", "--lib", "--profile", "profile.json"], {
    cwd: buildDir,
    env: {
      ...process.env,
      SCRIPTC_CC: "zigcc",
      SCRIPTC_TARGET: "aarch64-linux-android",
      ANDROID_NDK_ROOT: sdk.ndk,
    },
  });
  const lib = join(buildDir, ".scriptc", "entry.lib.a");
  if (!existsSync(lib)) fail(`scriptc produced no library at ${lib}`);

  // The shell is a shared library the Activity loads; Android has no main().
  console.log("janela: compiling the Android shell");
  const stage = join(buildDir, "apk");
  const jniDir = join(stage, "lib", ANDROID_ABI);
  mkdirSync(jniDir, { recursive: true });
  const so = join(jniDir, "libjanela.so");
  run([
    join(sdk.toolchain, `aarch64-linux-android${a.minSdk}-clang++`),
    join(KIT, "shim", "android", "app.cc"),
    "-shared", "-fPIC", "-std=c++17", "-O2",
    // The NDK links libc++ dynamically by default, which would mean shipping
    // libc++_shared.so beside ours; static keeps the APK to one library.
    "-static-libstdc++",
    `-I${join(KIT, "vendor-webview", "core", "include")}`,
    lib, "-llog", "-o", so,
  ]);
  run([join(sdk.toolchain, "llvm-strip"), so]);

  // The companion Java class the backend requires, plus janela's Activity.
  console.log("janela: compiling the Java bridge");
  const classes = join(buildDir, "classes");
  mkdirSync(classes, { recursive: true });
  const javaSrc = join(KIT, "shim", "android", "java");
  const sources = [
    join(javaSrc, "dev", "webview", "WebviewBridge.java"),
    join(javaSrc, "dev", "janela", "host", "JanelaActivity.java"),
  ];
  run([
    join(jdk, "bin", "javac"), "-source", "11", "-target", "11", "-nowarn",
    "-classpath", sdk.androidJar, "-d", classes, ...sources,
  ]);
  // d8 needs every class file named, including the inner classes javac
  // emitted for the @JavascriptInterface object and the WebViewClient.
  const classFiles = [];
  const collect = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) collect(p);
      else if (entry.name.endsWith(".class")) classFiles.push(p);
    }
  };
  collect(classes);
  run([join(sdk.bt, "d8"), "--min-api", a.minSdk, "--output", stage, ...classFiles]);

  // Launcher icons, if the project has one. aapt2 needs resources compiled to
  // .flat before they can be linked, so this is a two-step detour.
  const icon = iconSource(root, conf);
  let resZip = null;
  if (icon) {
    const resDir = join(buildDir, "res");
    rmSync(resDir, { recursive: true, force: true });
    if (makeAndroidRes(icon, resDir)) {
      resZip = join(buildDir, "res.zip");
      run([join(sdk.bt, "aapt2"), "compile", "--dir", resDir, "-o", resZip]);
    } else {
      console.warn("janela: could not generate launcher icons (sips unavailable) — building without one");
    }
  }

  writeFileSync(join(buildDir, "AndroidManifest.xml"), androidManifest(conf, { icon: Boolean(resZip) }));

  console.log("janela: packaging the APK");
  const unsigned = join(buildDir, "unsigned.apk");
  run([
    join(sdk.bt, "aapt2"), "link", "-o", unsigned, "-I", sdk.androidJar,
    "--manifest", join(buildDir, "AndroidManifest.xml"),
    "--min-sdk-version", a.minSdk,
    "--target-sdk-version", String(ANDROID_TARGET_SDK),
    ...(resZip ? [resZip] : []),
  ]);
  // aapt2 emits the manifest and resources; the code and the shared library
  // are added to the same zip afterwards.
  run(["zip", "-q", "-r", unsigned, "classes.dex", "lib"], { cwd: stage });

  const aligned = join(buildDir, "aligned.apk");
  run([join(sdk.bt, "zipalign"), "-f", "4", unsigned, aligned]);
  const apk = join(outDir, `${conf.name}.apk`);
  // A release keystore is the user's to own: janela never creates one and
  // never reads a password from the config file. Point `bundle.androidKeystore`
  // at a .jks and supply the passwords through the environment; absent that,
  // the APK is signed with a throwaway debug key that Play Store will reject.
  const ksConf = conf.bundle?.androidKeystore;
  if (ksConf) {
    const ksPath = resolve(root, ksConf.path ?? fail("bundle.androidKeystore needs a 'path'"));
    if (!existsSync(ksPath)) fail(`bundle.androidKeystore.path does not exist: ${ksPath}`);
    const storeEnv = ksConf.storePasswordEnv ?? "JANELA_ANDROID_STORE_PASSWORD";
    const keyEnv = ksConf.keyPasswordEnv ?? storeEnv;
    const storePass = process.env[storeEnv];
    if (!storePass) {
      fail(
        `bundle.androidKeystore is configured but $${storeEnv} is not set.\n` +
          "  Export the keystore password in the environment; janela will not read it from a file.",
      );
    }
    const keyPass = process.env[keyEnv] ?? storePass;
    run([
      join(sdk.bt, "apksigner"), "sign",
      "--ks", ksPath,
      ...(ksConf.alias ? ["--ks-key-alias", ksConf.alias] : []),
      "--ks-pass", `pass:${storePass}`, "--key-pass", `pass:${keyPass}`,
      "--out", apk, aligned,
    ]);
    console.log(`janela: signed with ${relative(root, ksPath)}`);
  } else {
    run([
      join(sdk.bt, "apksigner"), "sign",
      "--ks", debugKeystore(cacheDir, jdk),
      "--ks-pass", "pass:android", "--key-pass", "pass:android",
      "--out", apk, aligned,
    ]);
  }

  console.log(
    `janela: built ${relative(root, apk)} ` +
      `(${statSync(apk).size} bytes, ${ANDROID_ABI}; .so ${statSync(so).size} bytes)`,
  );
  return apk;
}

/// Boots an emulator if none is running, then installs and launches.
async function devAndroid(root) {
  const sdk = androidSdk();
  const conf = loadConf(root);
  const a = androidConf(conf);
  const apk = build(root, { target: "android" });

  const devices = capture([sdk.adb, "devices"]).split("\n").slice(1)
    .filter((l) => l.trim().endsWith("device"));
  if (!devices.length) {
    const avds = capture([join(sdk.home, "emulator", "emulator"), "-list-avds"])
      .split("\n").map((s) => s.trim()).filter(Boolean);
    if (!avds.length) {
      fail("no Android device or emulator. Create an AVD in Android Studio, or attach a device");
    }
    const avd = a.device ?? avds[0];
    console.log(`janela: booting ${avd}`);
    spawn(join(sdk.home, "emulator", "emulator"), ["-avd", avd, "-no-snapshot-save"], {
      detached: true, stdio: "ignore",
    }).unref();
    run([sdk.adb, "wait-for-device"]);
    // wait-for-device returns as soon as adb can talk to it; the package
    // manager is not up until the boot animation has finished.
    for (;;) {
      const done = capture([sdk.adb, "shell", "getprop", "sys.boot_completed"]).trim();
      if (done === "1") break;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  console.log("janela: installing");
  run([sdk.adb, "install", "-r", apk]);
  run([sdk.adb, "shell", "am", "start", "-n",
       `${a.applicationId}/dev.janela.host.JanelaActivity`]);
  console.log("janela: running (Ctrl-C to stop following the log)");
  run([sdk.adb, "logcat", "-s", "janela:*", "chromium:*", "AndroidRuntime:*"]);
}

// ---- shim ----------------------------------------------------------------

function which(bin) {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [bin], {
    encoding: "utf8",
  });
  return r.status === 0 ? r.stdout.trim().split("\n")[0] : null;
}

function buildShim(cacheDir) {
  const src = join(KIT, "shim", "wvshim.cc");
  const win = process.platform === "win32";
  // On Windows the object file is handed to the link directly: `ar` is not
  // part of an MSVC toolchain, and a lone object needs no archive index.
  const obj = join(cacheDir, win ? "wvshim.obj" : "wvshim.o");
  const lib = win ? obj : join(cacheDir, "libwvshim.a");
  if (existsSync(lib) && statSync(lib).mtimeMs > statSync(src).mtimeMs) return lib;

  console.log("janela: compiling webview shim");
  const inc = `-I${join(KIT, "vendor-webview", "core", "include")}`;
  if (win) {
    console.log(`janela: building for ${winCcOrFail()}`);
    run([
      "clang++", "-c", src, "-o", obj, "-std=c++17", "-O2", inc,
      // WebView2.h from the nuget SDK, plus mingw's missing EventToken.h.
      `-I${webview2Include(cacheDir)}`,
      `-I${join(KIT, "vendor-webview", "compatibility", "mingw", "include")}`,
      "-DWIN32_LEAN_AND_MEAN", "-D_WIN32_WINNT=0x0601",
    ]);
    return lib;
  }
  if (process.platform === "darwin") {
    run(["clang++", "-c", src, "-o", obj, "-std=c++17", "-O2", inc]);
  } else {
    const cflags = capture(["pkg-config", "--cflags", "gtk+-3.0", "webkit2gtk-4.1"]).split(/\s+/).filter(Boolean);
    run(["g++", "-c", src, "-o", obj, "-std=c++17", "-O2", inc, ...cflags]);
  }
  run(["ar", "rcs", lib, obj]);
  return lib;
}

// ---- FFI manifest ---------------------------------------------------------


// ---- Windows subsystem ------------------------------------------------------

// A console-subsystem .exe makes Windows open a console window behind the UI.
// The fix is normally `-mwindows` at link time, but scriptc exposes no way to
// pass a linker flag: `system_libraries` entries are validated as bare library
// names and explicitly rejected if they start with "-", `libraries` entries
// must resolve to existing files, and no env var is read for extra flags
// (checked in @scriptc/compiler 0.0.35: backend/cc.js, ffi/profile.js).
//
// So the subsystem byte is rewritten in the linked PE instead. The entry point
// is untouched — MinGW's mainCRTStartup runs either way; the field only tells
// the loader whether to allocate a console. Every offset is checked before
// anything is written, and a file that does not look like a console-subsystem
// PE is left alone.

function makeGuiSubsystem(exePath) {
  let result;
  try {
    result = patchPeSubsystem(readFileSync(exePath));
  } catch (e) {
    if (e instanceof PeError) fail(`${exePath} ${e.message}`);
    throw e;
  }
  if (result.patched) writeFileSync(exePath, result.buf);
}

// ---- build ----------------------------------------------------------------

// `devUrl` points the window at a running vite server instead of inlining the
// frontend; `gui` asks for a GUI-subsystem .exe on Windows (build, not dev).
// ---- icons and packaging ---------------------------------------------------
//
// One square source image becomes whatever each platform wants. Everything
// here is optional: a project with no icon configured and no icon.png builds
// exactly as it did before, and a platform whose converter is unavailable is
// skipped with a warning rather than failing the build.
//
// `sips` and `iconutil` ship with macOS, so icon generation currently requires
// building on a Mac. That is already true of .app/.dmg/iOS output.

/// The configured icon, or `icon.png` beside janela.conf.json, or null.
function iconSource(root, conf) {
  const named = conf.bundle?.icon ?? conf.icon;
  if (named) {
    const p = resolve(root, named);
    if (!existsSync(p)) fail(`bundle.icon '${named}' does not exist (resolved to ${p})`);
    return p;
  }
  const fallback = join(root, "icon.png");
  return existsSync(fallback) ? fallback : null;
}

function haveTool(name) {
  return spawnSync("command", ["-v", name], { shell: true, stdio: "ignore" }).status === 0;
}

/// Square PNG at `size`, written to `dst`. Returns false if sips is missing.
function resizePng(src, dst, size) {
  if (!haveTool("sips")) return false;
  const r = spawnSync("sips", ["-z", String(size), String(size), src, "--out", dst], { stdio: "ignore" });
  return r.status === 0;
}

const ICNS_SIZES = [16, 32, 64, 128, 256, 512, 1024];

/// macOS .icns via the iconset convention iconutil expects.
function makeIcns(src, cacheDir, name) {
  if (!haveTool("iconutil") || !haveTool("sips")) return null;
  const iconset = join(cacheDir, `${name}.iconset`);
  rmSync(iconset, { recursive: true, force: true });
  mkdirSync(iconset, { recursive: true });
  // iconutil wants both @1x and @2x names; a 32px @2x is the 64px render.
  for (const s of ICNS_SIZES) {
    if (s <= 512) resizePng(src, join(iconset, `icon_${s}x${s}.png`), s);
    if (s >= 32) resizePng(src, join(iconset, `icon_${s / 2}x${s / 2}@2x.png`), s);
  }
  const icns = join(cacheDir, `${name}.icns`);
  const r = spawnSync("iconutil", ["-c", "icns", iconset, "-o", icns], { stdio: "ignore" });
  return r.status === 0 && existsSync(icns) ? icns : null;
}

const ICO_SIZES = [16, 32, 48, 64, 128, 256];

/// Windows .ico. The format allows PNG payloads (Vista+), so this needs no
/// image library: a 6-byte header, one 16-byte directory entry per image,
/// then the PNG bytes.
function makeIco(src, cacheDir, name) {
  if (!haveTool("sips")) return null;
  const pngs = [];
  for (const s of ICO_SIZES) {
    const p = join(cacheDir, `ico-${s}.png`);
    if (resizePng(src, p, s)) pngs.push({ size: s, data: readFileSync(p) });
  }
  if (!pngs.length) return null;

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(pngs.length, 4);

  let offset = 6 + pngs.length * 16;
  const entries = [];
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0); // 0 means 256
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2); // palette
    e.writeUInt8(0, 3); // reserved
    e.writeUInt16LE(1, 4); // colour planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += data.length;
  }
  const ico = join(cacheDir, `${name}.ico`);
  writeFileSync(ico, Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]));
  return ico;
}

/// iOS icons. The modern route is a compiled asset catalogue; the older
/// CFBundleIconFiles list still works and needs no actool, which keeps the
/// hand-rolled bundle self-contained.
const IOS_ICON_SIZES = [40, 58, 60, 80, 87, 120, 180, 1024];

function makeIosIcons(src, bundleDir) {
  if (!haveTool("sips")) return [];
  const names = [];
  for (const s of IOS_ICON_SIZES) {
    const base = `AppIcon${s}.png`;
    if (resizePng(src, join(bundleDir, base), s)) names.push(base);
  }
  return names;
}

/// Android launcher icons: one PNG per density bucket under res/mipmap-*.
const ANDROID_DENSITIES = [["mdpi", 48], ["hdpi", 72], ["xhdpi", 96], ["xxhdpi", 144], ["xxxhdpi", 192]];

function makeAndroidRes(src, resDir) {
  if (!haveTool("sips")) return false;
  let any = false;
  for (const [bucket, size] of ANDROID_DENSITIES) {
    const dir = join(resDir, `mipmap-${bucket}`);
    mkdirSync(dir, { recursive: true });
    if (resizePng(src, join(dir, "ic_launcher.png"), size)) any = true;
  }
  return any;
}

/// A plain drag-to-Applications disk image from an existing .app.
function makeDmg(appDir, outDir, name, version) {
  if (!haveTool("hdiutil")) {
    console.warn("janela: hdiutil not available — skipping .dmg");
    return null;
  }
  const stage = join(outDir, `.dmg-stage-${name}`);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  cpSync(appDir, join(stage, `${name}.app`), { recursive: true });
  spawnSync("ln", ["-s", "/Applications", join(stage, "Applications")], { stdio: "ignore" });

  const dmg = join(outDir, `${name}-${version}.dmg`);
  rmSync(dmg, { force: true });
  const r = spawnSync("hdiutil", [
    "create", "-volname", name, "-srcfolder", stage,
    "-ov", "-format", "UDZO", "-quiet", dmg,
  ], { stdio: "inherit" });
  rmSync(stage, { recursive: true, force: true });
  if (r.status !== 0 || !existsSync(dmg)) {
    console.warn("janela: hdiutil failed — skipping .dmg");
    return null;
  }
  return dmg;
}

function build(root, { devUrl = null, gui = true, target = "desktop" } = {}) {
  const conf = loadConf(root);
  const ios = target === "ios";
  const android = target === "android";
  // Both mobile targets are library-mode: the platform owns the loop and the
  // shell calls into a linked scriptc library. Everything above the shell is
  // shared between them.
  const mobile = ios || android;
  const suffix = ios ? "-ios" : android ? "-android" : "";
  const buildDir = join(root, ".janela", `build${suffix}`);
  const cacheDir = join(root, ".janela", "cache");
  const outDir = join(root, ".janela", `out${suffix}`);
  for (const d of [buildDir, cacheDir, outDir]) mkdirSync(d, { recursive: true });

  // Desktop links a C shim over webview.h; iOS links no shim at all — the
  // UIKit shell is the program, and it links this build's output instead.
  const shimLib = mobile ? null : buildShim(cacheDir);

  // Assemble the compile unit: runtime + user's commands + generated modules.
  // Which runtime lane lands here as "./janela" is the whole difference
  // between the two targets — a project's main.ts is compiled unchanged
  // against either.
  // ios.ts is the library-mode runtime: Android uses it unchanged, which is
  // the point — the same TypeScript serves both mobile shells.
  cpSync(join(KIT, "runtime", mobile ? "ios.ts" : "janela.ts"), join(buildDir, "janela.ts"));
  cpSync(join(KIT, "runtime", "types.ts"), join(buildDir, "types.ts"));
  const mainSrc = join(root, "src-host", "main.ts");
  if (!existsSync(mainSrc)) fail("missing src-host/main.ts");
  // A project's main.ts imports from "janela/host" so that it resolves in the
  // editor against the installed package. Here it is compiled next to the
  // runtime instead, so the specifier is rewritten to that local copy: the
  // build never resolves through node_modules, which keeps it static and will
  // keep working when "janela/host" starts exporting values (not just types)
  // as well.
  writeFileSync(
    join(buildDir, "main.ts"),
    rewriteHostSpecifier(readFileSync(mainSrc, "utf8")),
  );

  const html = frontendHtml(root, conf, devUrl);
  writeFileSync(
    join(buildDir, "frontend.ts"),
    `// Generated by janela — do not edit.\nexport const INDEX_HTML: string = ${JSON.stringify(html)};\n`,
  );

  const w = conf.window;
  writeFileSync(
    join(buildDir, "config.ts"),
    `// Generated by janela from janela.conf.json — do not edit.\n` +
      `export const WINDOW = { title: ${JSON.stringify(String(w.title ?? conf.name))}, ` +
      `width: ${Number(w.width ?? 800)}, height: ${Number(w.height ?? 600)} };\n`,
  );

  // The iOS entry exports the library's two entry points instead of running a
  // loop: UIKit owns the loop and calls in. Everything above this line — the
  // contract, main.ts, the flattened frontend — is identical to desktop.
  const entryTail = mobile
    ? `const app = createApp<CmdsOf<typeof setup>, EvtsOf<typeof setup>>(WINDOW);\n` +
      `setup(app);\n` +
      `app.setHtml(INDEX_HTML);\n\n` +
      `/** One page invoke; the UIKit shell calls this through the library ABI. */\n` +
      `export function handleInvoke(cmd: string, argsJson: string): string {\n` +
      `  return app.dispatch(cmd, argsJson);\n` +
      `}\n\n` +
      `/** The document the shell loads into its WKWebView. */\n` +
      `export function indexHtml(): string {\n` +
      `  return app.indexHtml();\n` +
      `}\n\n` +
      `/** A continuation the shell parked has come due (main queue). */\n` +
      `export function onTimer(id: number): void {\n` +
      `  app.onTimer(id);\n` +
      `}\n\n` +
      `/** A file job the shell owns has finished (main queue). */\n` +
      `export function onFsDone(id: number, ok: boolean, payload: string): void {\n` +
      `  app.onFsDone(id, ok, payload);\n` +
      `}\n` +
      `export function onDialogDone(id: number, ok: boolean, payload: string): void {\n` +
      `  app.onDialogDone(id, ok, payload);\n` +
      `}\n`
    : `const app = createApp<CmdsOf<typeof setup>, EvtsOf<typeof setup>>(WINDOW);\n` +
      `setup(app);\n` +
      `const rc = app.run(INDEX_HTML) + 0;\n` +
      `console.log("[janela] run returned", rc);\n`;

  writeFileSync(
    join(buildDir, "entry.ts"),
    `// Generated by janela — do not edit.\n` +
      `import { createApp } from "./janela";\n` +
      `import type { CommandShapes, JanelaAppImpl } from "./janela";\n` +
      `import { WINDOW } from "./config";\n` +
      `import { INDEX_HTML } from "./frontend";\n` +
      `import { setup } from "./main";\n\n` +
      `// The app's type parameters are read back off setup()'s own signature,\n` +
      `// so a contract-typed setup(app: App) and a plain setup(app: JanelaApp)\n` +
      `// each get an app instantiated to match. scriptc monomorphises generic\n` +
      `// classes, so the right instantiation must be CONSTRUCTED here - no cast\n` +
      `// can bridge two of them. The inference reads the CLASS, not the\n` +
      `// JanelaApp alias: the alias applies Norm<C>, which cannot be reversed,\n` +
      `// and what is wanted here is the normalised table anyway.\n` +
      `type CmdsOf<F> = F extends (app: JanelaAppImpl<infer C, infer _E>) => void ? C : CommandShapes;\n` +
      `type EvtsOf<F> = F extends (app: JanelaAppImpl<infer _C, infer E>) => void ? E : Record<string, unknown>;\n\n` +
      entryTail,
  );

  if (ios) return buildIos(root, conf, buildDir, outDir);
  if (android) return buildAndroid(root, conf, buildDir, outDir);

  writeFileSync(join(buildDir, "janela.ffi.json"), JSON.stringify(ffiManifest(shimLib, {
      macSdkPath:
        process.platform === "darwin"
          ? capture(["xcrun", "--sdk", "macosx", "--show-sdk-path"])
          : null,
    }), null, 2) + "\n");

  console.log("janela: compiling TypeScript to a native binary");
  // An explicit --out is used verbatim, so the PE suffix is ours to add.
  const bin = join(outDir, process.platform === "win32" ? `${conf.name}.exe` : conf.name);
  // No SCRIPTC_CC/SCRIPTC_TARGET on Windows: scriptc's default driver is
  // plain `clang`, which is exactly the MinGW-targeting clang checked above.
  run(["node", scriptcBin(), "build", "entry.ts", "--ffi", "janela.ffi.json", "-o", bin], { cwd: buildDir });

  // Symbol/debug metadata is ~16% of the binary and apps don't need it.
  // (On arm64 macOS, strip re-signs ad-hoc automatically. MinGW keeps DWARF
  // inside the .exe rather than a side-by-side .pdb, so Windows benefits too.)
  run(["strip", bin]);

  // `janela dev` keeps the console subsystem so console.log from a command is
  // visible in the terminal; a shipped `janela build` must not flash a console
  // window behind the UI, and loses stdout as the price.
  if (process.platform === "win32" && gui) {
    makeGuiSubsystem(bin);
    console.log("janela: linked as a GUI-subsystem .exe (no console window)");
  }

  const icon = iconSource(root, conf);

  if (process.platform === "win32" && icon) {
    // Embedding into the PE needs a resource compiler we cannot rely on, so
    // the .ico is written beside the .exe — installers and shortcuts take a
    // path, and this keeps the build toolchain-free.
    const ico = makeIco(icon, cacheDir, conf.name);
    if (ico) {
      cpSync(ico, join(outDir, `${conf.name}.ico`));
      console.log(`janela: wrote ${conf.name}.ico beside the .exe`);
    } else {
      console.warn("janela: could not generate a .ico (sips unavailable) — skipping the icon");
    }
  }

  if (process.platform === "darwin") {
    const bundle = join(outDir, `${conf.name}.app`);
    rmSync(bundle, { recursive: true, force: true });
    mkdirSync(join(bundle, "Contents", "MacOS"), { recursive: true });
    cpSync(bin, join(bundle, "Contents", "MacOS", conf.name));

    let iconKey = "";
    if (icon) {
      const icns = makeIcns(icon, cacheDir, conf.name);
      if (icns) {
        mkdirSync(join(bundle, "Contents", "Resources"), { recursive: true });
        cpSync(icns, join(bundle, "Contents", "Resources", `${conf.name}.icns`));
        iconKey = `\n  <key>CFBundleIconFile</key><string>${conf.name}</string>`;
      } else {
        console.warn("janela: could not generate an .icns (iconutil/sips unavailable) — skipping the icon");
      }
    }

    writeFileSync(
      join(bundle, "Contents", "Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>${conf.name}</string>
  <key>CFBundleDisplayName</key><string>${conf.name}</string>
  <key>CFBundleIdentifier</key><string>${conf.identifier}</string>
  <key>CFBundleExecutable</key><string>${conf.name}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>${conf.version ?? "0.1.0"}</string>
  <key>CFBundleShortVersionString</key><string>${conf.version ?? "0.1.0"}</string>
  <key>NSHighResolutionCapable</key><true/>${iconKey}
</dict>
</plist>
`,
    );
    spawnSync("codesign", ["--force", "--sign", "-", bundle]);
    console.log(`janela: built ${relative(root, bin)} and ${relative(root, bundle)}`);

    // Opt-in: a .dmg is for shipping, not for `janela dev`.
    if (conf.bundle?.dmg) {
      const dmg = makeDmg(bundle, outDir, conf.name, conf.version ?? "0.1.0");
      if (dmg) console.log(`janela: built ${relative(root, dmg)} (${statSync(dmg).size} bytes)`);
    }
  } else if (process.platform !== "win32") {
    console.log(`janela: built ${relative(root, bin)}`);
  } else {
    console.log(`janela: built ${relative(root, bin)}`);
  }
  return bin;
}

// ---- init -----------------------------------------------------------------

const TEMPLATES = ["vanilla", "vue", "react", "svelte", "solid"];

// Copy a template tree, substituting the project name in text files.
function copyTemplate(from, to, name) {
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const src = join(from, entry.name);
    const dst = join(to, entry.name);
    if (entry.isDirectory()) {
      mkdirSync(dst, { recursive: true });
      copyTemplate(src, dst, name);
    } else {
      writeFileSync(dst, readFileSync(src, "utf8").replaceAll("__NAME__", name));
    }
  }
}

// A project name becomes an npm package name, a binary name, a bundle
// identifier segment and a window title, so it is deliberately narrow:
// start with a letter, then letters, digits, '-' or '_'. Underscores are
// allowed because people type them and every downstream use accepts them —
// Android application ids in particular *prefer* them, since a Java package
// segment cannot contain a hyphen (see androidApplicationId).

// Best-effort repair of a rejected name, so the error can suggest something
// that would have worked instead of only stating the rule.
function init(name, template) {
  if (!name) {
    fail(
      "no project name given.\n" +
        "  usage: janela init <name> [--template vanilla|vue|react|svelte|solid]",
    );
  }
  if (!NAME_RE.test(name)) {
    const hint = suggestName(name);
    fail(
      `'${name}' is not a usable project name.\n` +
        "  A name must start with a lowercase letter, then contain only\n" +
        "  lowercase letters, digits, '-' or '_'.\n" +
        (hint ? `  Try: janela init ${hint}\n` : "") +
        "  Nothing was created.",
    );
  }
  if (!TEMPLATES.includes(template)) fail(`unknown template '${template}' (${TEMPLATES.join(", ")})`);
  const dir = resolve(process.cwd(), name);
  if (existsSync(dir)) fail(`${name}/ already exists`);
  mkdirSync(join(dir, "src-host"), { recursive: true });

  // Installed from the registry (this file lives under node_modules) →
  // depend on the published version; a source checkout → a file: link.
  const kitPkg = JSON.parse(readFileSync(join(KIT, "package.json"), "utf8"));
  const janelaDep = KIT.includes(`${sep}node_modules${sep}`)
    ? `^${kitPkg.version}`
    : `file:${relative(dir, KIT) || "."}`;

  const pkg = {
    name,
    private: true,
    scripts: { dev: "janela dev", build: "janela build" },
    devDependencies: { janela: janelaDep },
  };

  if (template === "vanilla") {
    // The zero-dependency shape janela has always scaffolded: no frontend
    // toolchain, no npm install needed before the first build.
    const t = (f) => readFileSync(join(KIT, "templates", f), "utf8").replaceAll("__NAME__", name);
    writeFileSync(join(dir, "index.html"), t("index.html"));
    writeFileSync(join(dir, "src-host", "main.ts"), t("main.ts"));
    writeFileSync(join(dir, "janela.conf.json"), t("janela.conf.json"));
  } else {
    const tdir = join(KIT, "templates", template);
    copyTemplate(join(tdir, "files"), dir, name);
    const extra = JSON.parse(readFileSync(join(tdir, "deps.json"), "utf8"));
    pkg.type = "module";
    Object.assign(pkg.devDependencies, extra.devDependencies ?? {});
    Object.assign(pkg.scripts, extra.scripts ?? {});
    if (extra.dependencies) pkg.dependencies = extra.dependencies;
  }

  writeFileSync(join(dir, ".gitignore"), ".janela/\nnode_modules/\ndist/\n");
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2) + "\n");

  const install = template === "vanilla" ? "" : "npm install && ";
  console.log(`janela: created ${name}/ (${template}) — next: cd ${name} && ${install}janela dev`);
}

// ---- dev --------------------------------------------------------------------

function freePort() {
  return new Promise((ok, no) => {
    const s = createServer();
    s.on("error", no);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });
}

async function waitForServer(url, child, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) fail(`the vite dev server exited (code ${child.exitCode})`);
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (r.ok || r.status === 404) return;
    } catch {
      // not listening yet
    }
    await new Promise((ok) => setTimeout(ok, 150));
  }
  fail(`the vite dev server did not answer at ${url} within ${timeoutMs / 1000}s`);
}

async function dev(root) {
  let vite = null;
  let devUrl = null;

  if (viteConfigPath(root)) {
    const port = await freePort();
    devUrl = `http://localhost:${port}/`;
    console.log(`janela: starting the vite dev server on ${devUrl}`);
    const viteCmd = viteCommand(root);
    vite = spawn(viteCmd.argv[0], [...viteCmd.argv.slice(1), "--port", String(port), "--strictPort"], {
      cwd: root,
      stdio: "inherit",
      shell: viteCmd.shell,
    });
    const stop = () => { if (vite && vite.exitCode === null) vite.kill(); };
    process.on("exit", stop);
    process.on("SIGINT", () => { stop(); process.exit(130); });
    await waitForServer(devUrl, vite);
  }

  // Console subsystem on Windows: dev is where you want the logs.
  const bin = build(root, { devUrl, gui: false });
  console.log("janela: running (close the window or Ctrl-C to stop)");
  // The frontend hot-reloads through vite; host changes need another `dev`.
  run([bin]);
  if (vite && vite.exitCode === null) vite.kill();
}

// ---- main -----------------------------------------------------------------

const argv = process.argv.slice(2);
const cmd = argv[0];

function flag(name, fallback) {
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--")) return argv[i + 1];
  return fallback;
}

// Everything after the subcommand that is neither a flag nor a flag's value.
function positionals() {
  const out = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { out.push(a); continue; }
    if (!a.includes("=") && argv[i + 1] && !argv[i + 1].startsWith("--")) i++;
  }
  return out;
}

const TARGETS = ["desktop", "ios", "android"];

function targetOrFail() {
  const t = flag("target", "desktop");
  if (!TARGETS.includes(t)) fail(`unknown target '${t}' (${TARGETS.join(", ")})`);
  return t;
}

// A mistyped flag used to be ignored in silence: `--targt ios` fell back to
// the desktop default, built the wrong thing and exited 0. Anything a caller
// did not spell exactly is now an error, because a build that quietly ignores
// what it was asked for is indistinguishable from success.
function assertKnownFlags(allowed) {
  const known = new Set(allowed);
  for (const a of argv.slice(1)) {
    if (!a.startsWith("--")) continue;
    const nm = a.slice(2).split("=")[0];
    if (!known.has(nm)) {
      const near = allowed.filter((k) => k.startsWith(nm.slice(0, 3)) || nm.startsWith(k.slice(0, 3)));
      fail(
        `unknown option '--${nm}' for 'janela ${cmd}'.\n` +
          `  Known options: ${allowed.map((k) => `--${k}`).join(", ") || "(none)"}` +
          (near.length ? `\n  Did you mean --${near[0]}?` : ""),
      );
    }
  }
}

// Extra positionals were silently dropped, so `janela init a b` created 'a'
// and said nothing about 'b'.
function assertPositionals(max) {
  const p = positionals();
  if (p.length > max) {
    fail(`unexpected extra argument '${p[max]}' for 'janela ${cmd}'.\n  Nothing was created.`);
  }
}

switch (cmd) {
  case "init":
    assertKnownFlags(["template"]);
    assertPositionals(1);
    init(positionals()[0], flag("template", "vanilla"));
    break;
  case "build":
    assertKnownFlags(["target"]);
    assertPositionals(0);
    build(process.cwd(), { target: targetOrFail() });
    break;
  case "dev":
    {
      assertKnownFlags(["target"]);
      assertPositionals(0);
      const t = targetOrFail();
      if (t === "ios") await devIos(process.cwd());
      else if (t === "android") await devAndroid(process.cwd());
      else await dev(process.cwd());
    }
    break;
  default:
    console.log(
      "usage: janela init <name> [--template vanilla|vue|react|svelte|solid]\n" +
        "       janela build [--target desktop|ios|android]\n" +
        "       janela dev   [--target desktop|ios|android]",
    );
    process.exit(cmd ? 1 : 0);
}
