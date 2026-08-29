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

import { spawnSync } from "node:child_process";
import {
  cpSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

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

// ---- shim ----------------------------------------------------------------

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

const STR = (name, symbol) => ({ name, symbol, params: ["i32", "string"], returns: "i32" });

function ffiManifest(shimLib) {
  const functions = [
    { name: "wvCreate", symbol: "wv_create", params: ["i32"], returns: "i32" },
    STR("wvSetTitle", "wv_set_title"),
    { name: "wvSetSize", symbol: "wv_set_size", params: ["i32", "i32", "i32", "i32"], returns: "i32" },
    STR("wvSetHtml", "wv_set_html"),
    STR("wvInit", "wv_init"),
    STR("wvEval", "wv_eval"),
    STR("wvBind", "wv_bind"),
    { name: "wvReqLen", symbol: "wv_req_len", params: ["i32"], returns: "i32" },
    { name: "wvReqByte", symbol: "wv_req_byte", params: ["i32", "i32"], returns: "i32" },
    { name: "wvReplyReset", symbol: "wv_reply_reset", params: ["i32"], returns: "i32" },
    { name: "wvReplyPush", symbol: "wv_reply_push", params: ["i32", "i32"], returns: "i32" },
    {
      name: "wvRun", symbol: "wv_run",
      params: [
        "i32",
        { callback: { id: "run", params: ["u32", "u32", { context: "run" }], returns: "i32", lifetime: "call" } },
        { context: "run" },
      ],
      returns: "i32",
    },
    { name: "wvTerminate", symbol: "wv_terminate", params: ["i32"], returns: "i32" },
    // async: deferred returns + the UI-thread pump behind app.defer/sleep
    { name: "wvDefer", symbol: "wv_defer", params: ["i32"], returns: "i32" },
    { name: "wvResolve", symbol: "wv_resolve", params: ["i32", "i32", "i32"], returns: "i32" },
    { name: "wvTickStart", symbol: "wv_tick_start", params: ["i32", "i32"], returns: "i32" },
    { name: "wvTickStop", symbol: "wv_tick_stop", params: ["i32"], returns: "i32" },
  ];

  if (process.platform === "win32") {
    // MinGW ignores MSVC's #pragma comment(lib, ...), so the Win32 imports the
    // WebView2 backend needs are named explicitly. scriptc's own win32 lane
    // already adds advapi32/iphlpapi/ws2_32, so those are omitted here.
    // `c++` pulls libc++ for the shim's std::string/exceptions.
    //
    // `pthread` (mingw's libwinpthread) is here to work around an upstream
    // scriptc bug: its runtime calls clock_gettime/nanosleep, which mingw
    // declares in <time.h> but implements in winpthreads, and scriptc's win32
    // link never adds it. Without this the link dies with
    // "undefined symbol: clock_gettime" — reproducible with a plain
    // `scriptc build hello.ts` on Windows, no FFI involved.
    return {
      ffi_format: 2,
      functions,
      libraries: [shimLib],
      system_libraries: [
        "c++", "pthread",
        "ole32", "oleaut32", "shlwapi", "shell32", "user32", "version", "gdi32",
      ],
    };
  }

  if (process.platform === "darwin") {
    // scriptc has no -framework support, but `libraries` entries are passed to
    // the link as plain input files and ld64 accepts .tbd stubs.
    const sdk = capture(["xcrun", "--sdk", "macosx", "--show-sdk-path"]);
    return {
      ffi_format: 2,
      functions,
      libraries: [
        shimLib,
        join(sdk, "System/Library/Frameworks/WebKit.framework/WebKit.tbd"),
        join(sdk, "System/Library/Frameworks/Cocoa.framework/Cocoa.tbd"),
      ],
      system_libraries: ["c++"],
    };
  }
  return {
    ffi_format: 2,
    functions,
    libraries: [shimLib],
    system_libraries: [
      "stdc++", "webkit2gtk-4.1", "javascriptcoregtk-4.1", "gtk-3", "gdk-3",
      "soup-3.0", "gio-2.0", "gobject-2.0", "glib-2.0", "gmodule-2.0",
      "pango-1.0", "pangocairo-1.0", "harfbuzz", "atk-1.0", "cairo",
      "cairo-gobject", "gdk_pixbuf-2.0", "z", "pthread",
    ],
  };
}

// ---- build ----------------------------------------------------------------

function build(root) {
  const conf = loadConf(root);
  const buildDir = join(root, ".janela", "build");
  const cacheDir = join(root, ".janela", "cache");
  const outDir = join(root, ".janela", "out");
  for (const d of [buildDir, cacheDir, outDir]) mkdirSync(d, { recursive: true });

  const shimLib = buildShim(cacheDir);

  // Assemble the compile unit: runtime + user's commands + generated modules.
  cpSync(join(KIT, "runtime", "janela.ts"), join(buildDir, "janela.ts"));
  const mainSrc = join(root, "src-host", "main.ts");
  if (!existsSync(mainSrc)) fail("missing src-host/main.ts");
  cpSync(mainSrc, join(buildDir, "main.ts"));

  const htmlSrc = join(root, "index.html");
  if (!existsSync(htmlSrc)) fail("missing index.html");
  const html = readFileSync(htmlSrc, "utf8");
  writeFileSync(
    join(buildDir, "frontend.ts"),
    `// Generated by janela from index.html — do not edit.\nexport const INDEX_HTML: string = ${JSON.stringify(html)};\n`,
  );

  const w = conf.window;
  writeFileSync(
    join(buildDir, "config.ts"),
    `// Generated by janela from janela.conf.json — do not edit.\n` +
      `export const WINDOW = { title: ${JSON.stringify(String(w.title ?? conf.name))}, ` +
      `width: ${Number(w.width ?? 800)}, height: ${Number(w.height ?? 600)} };\n`,
  );

  writeFileSync(
    join(buildDir, "entry.ts"),
    `// Generated by janela — do not edit.\n` +
      `import { createApp } from "./janela";\n` +
      `import { WINDOW } from "./config";\n` +
      `import { INDEX_HTML } from "./frontend";\n` +
      `import { setup } from "./main";\n\n` +
      `const app = createApp(WINDOW);\n` +
      `setup(app);\n` +
      `const rc = app.run(INDEX_HTML) + 0;\n` +
      `console.log("[janela] run returned", rc);\n`,
  );

  writeFileSync(join(buildDir, "janela.ffi.json"), JSON.stringify(ffiManifest(shimLib), null, 2) + "\n");

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

  if (process.platform === "darwin") {
    const bundle = join(outDir, `${conf.name}.app`);
    mkdirSync(join(bundle, "Contents", "MacOS"), { recursive: true });
    cpSync(bin, join(bundle, "Contents", "MacOS", conf.name));
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
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
`,
    );
    spawnSync("codesign", ["--force", "--sign", "-", bundle]);
    console.log(`janela: built ${relative(root, bin)} and ${relative(root, bundle)}`);
  } else {
    console.log(`janela: built ${relative(root, bin)}`);
  }
  return bin;
}

// ---- init -----------------------------------------------------------------

function init(name) {
  if (!name || !/^[a-z][a-z0-9-]*$/.test(name)) fail("usage: janela init <name> (lowercase, digits, dashes)");
  const dir = resolve(process.cwd(), name);
  if (existsSync(dir)) fail(`${name}/ already exists`);
  mkdirSync(join(dir, "src-host"), { recursive: true });

  // Installed from the registry (this file lives under node_modules) →
  // depend on the published version; a source checkout → a file: link.
  const kitPkg = JSON.parse(readFileSync(join(KIT, "package.json"), "utf8"));
  const janelaDep = KIT.includes(`${sep}node_modules${sep}`)
    ? `^${kitPkg.version}`
    : `file:${relative(dir, KIT) || "."}`;

  const t = (f) => readFileSync(join(KIT, "templates", f), "utf8").replaceAll("__NAME__", name);
  writeFileSync(join(dir, "index.html"), t("index.html"));
  writeFileSync(join(dir, "src-host", "main.ts"), t("main.ts"));
  writeFileSync(join(dir, "janela.conf.json"), t("janela.conf.json"));
  writeFileSync(join(dir, ".gitignore"), ".janela/\nnode_modules/\n");
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify(
      {
        name,
        private: true,
        scripts: { dev: "janela dev", build: "janela build" },
        devDependencies: { janela: janelaDep },
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`janela: created ${name}/ — next: cd ${name} && janela dev`);
}

// ---- main -----------------------------------------------------------------

const [cmd, arg] = process.argv.slice(2);
switch (cmd) {
  case "init":
    init(arg);
    break;
  case "build":
    build(process.cwd());
    break;
  case "dev": {
    const bin = build(process.cwd());
    console.log("janela: running (close the window or Ctrl-C to stop)");
    run([bin]);
    break;
  }
  default:
    console.log("usage: janela init <name> | janela build | janela dev");
    process.exit(cmd ? 1 : 0);
}
