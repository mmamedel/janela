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
  cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
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

function viteBin(root) {
  const p = join(root, "node_modules", ".bin", process.platform === "win32" ? "vite.cmd" : "vite");
  if (!existsSync(p)) {
    fail(
      "this project has a vite config but no local vite — run your package manager's " +
        "install first (npm install / pnpm install)",
    );
  }
  return p;
}

const MIME = {
  ".css": "text/css", ".js": "text/javascript", ".json": "application/json",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif",
  ".svg": "image/svg+xml", ".ico": "image/x-icon",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf",
  ".mp3": "audio/mpeg", ".mp4": "video/mp4", ".webm": "video/webm",
};

function mimeFor(p) {
  const dot = p.lastIndexOf(".");
  return (dot < 0 ? null : MIME[p.slice(dot).toLowerCase()]) ?? "application/octet-stream";
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
    run([viteBin(root), "build"], { cwd: root });
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
    STR("wvReply", "wv_reply"),
    // Retained handlers (format 4): registered once, valid for the app's
    // lifetime, so wv_run is a plain blocking call. The request rides in as a
    // `string` param (format 3) rather than a byte-at-a-time drain.
    {
      name: "wvOnInvoke", symbol: "wv_on_invoke",
      params: [
        "i32",
        { callback: { id: "inv", params: ["string", { context: "inv" }], returns: "i32", lifetime: "retained" } },
        { context: "inv" },
      ],
      returns: "i32",
    },
    {
      name: "wvOnTick", symbol: "wv_on_tick",
      params: [
        "i32",
        { callback: { id: "tick", params: [{ context: "tick" }], returns: "void", lifetime: "retained" } },
        { context: "tick" },
      ],
      returns: "i32",
    },
    { name: "wvRun", symbol: "wv_run", params: ["i32"], returns: "i32" },
    { name: "wvTerminate", symbol: "wv_terminate", params: ["i32"], returns: "i32" },
    // async: deferred returns + the UI-thread pump behind app.defer/sleep
    { name: "wvDefer", symbol: "wv_defer", params: ["i32"], returns: "i32" },
    { name: "wvResolve", symbol: "wv_resolve", params: ["i32", "i32", "i32"], returns: "i32" },
    { name: "wvTickStart", symbol: "wv_tick_start", params: ["i32", "i32"], returns: "i32" },
    { name: "wvTickStop", symbol: "wv_tick_stop", params: ["i32"], returns: "i32" },
    // async file I/O: the blocking syscall runs on a shim worker thread
    { name: "wvFsRead", symbol: "wv_fs_read", params: ["i32", "string"], returns: "i32" },
    { name: "wvFsWrite", symbol: "wv_fs_write", params: ["i32", "string", "string"], returns: "i32" },
    // Job accessors, shared by file I/O and dialogs: both are work whose
    // answer cannot be produced during the FFI call that starts it.
    { name: "wvJobStatus", symbol: "wv_job_status", params: ["i32", "i32"], returns: "i32" },
    {
      name: "wvJobTake", symbol: "wv_job_take",
      params: [
        "i32", "i32",
        { callback: { id: "sink", params: ["string", { context: "sink" }], returns: "void", lifetime: "call" } },
        { context: "sink" },
      ],
      returns: "i32",
    },
    { name: "wvJobFree", symbol: "wv_job_free", params: ["i32", "i32"], returns: "i32" },
    // Native dialogs: the modal runs on a later UI-thread turn, so asking for
    // one never blocks the invoke that asked. Options ride as plain params
    // (kind, flags, title, defaultPath, defaultName, filters).
    {
      name: "wvDialog", symbol: "wv_dialog",
      params: ["i32", "i32", "i32", "string", "string", "string", "string"],
      returns: "i32",
    },
    { name: "wvSetFullscreen", symbol: "wv_set_fullscreen", params: ["i32", "i32"], returns: "i32" },
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
      ffi_format: 4,
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
      ffi_format: 4,
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
    ffi_format: 4,
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
const IMAGE_SUBSYSTEM_WINDOWS_GUI = 2;
const IMAGE_SUBSYSTEM_WINDOWS_CUI = 3;

function makeGuiSubsystem(exePath) {
  const buf = readFileSync(exePath);
  if (buf.length < 0x40 || buf.readUInt16LE(0) !== 0x5a4d) {
    fail(`${exePath} is not a PE image (no MZ header)`);
  }
  const peOff = buf.readUInt32LE(0x3c);
  if (peOff + 24 > buf.length || buf.readUInt32LE(peOff) !== 0x00004550) {
    fail(`${exePath} has no PE signature at ${peOff}`);
  }
  // Optional header starts after the 4-byte signature and 20-byte COFF header;
  // Subsystem sits at +68 in both PE32 (0x10b) and PE32+ (0x20b).
  const optOff = peOff + 24;
  const magic = buf.readUInt16LE(optOff);
  if (magic !== 0x10b && magic !== 0x20b) {
    fail(`${exePath} has an unrecognised optional header magic 0x${magic.toString(16)}`);
  }
  const subOff = optOff + 68;
  if (subOff + 2 > buf.length) fail(`${exePath} is truncated before its Subsystem field`);
  const current = buf.readUInt16LE(subOff);
  if (current === IMAGE_SUBSYSTEM_WINDOWS_GUI) return;
  if (current !== IMAGE_SUBSYSTEM_WINDOWS_CUI) {
    fail(`${exePath} has an unexpected subsystem ${current}; refusing to rewrite it`);
  }
  buf.writeUInt16LE(IMAGE_SUBSYSTEM_WINDOWS_GUI, subOff);
  writeFileSync(exePath, buf);
}

// ---- build ----------------------------------------------------------------

// `devUrl` points the window at a running vite server instead of inlining the
// frontend; `gui` asks for a GUI-subsystem .exe on Windows (build, not dev).
function build(root, { devUrl = null, gui = true } = {}) {
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

  // `janela dev` keeps the console subsystem so console.log from a command is
  // visible in the terminal; a shipped `janela build` must not flash a console
  // window behind the UI, and loses stdout as the price.
  if (process.platform === "win32" && gui) {
    makeGuiSubsystem(bin);
    console.log("janela: linked as a GUI-subsystem .exe (no console window)");
  }

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

function init(name, template) {
  if (!name || !/^[a-z][a-z0-9-]*$/.test(name)) fail("usage: janela init <name> [--template <t>] (lowercase, digits, dashes)");
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
    vite = spawn(viteBin(root), ["--port", String(port), "--strictPort"], {
      cwd: root,
      stdio: "inherit",
      // Windows resolves .cmd shims through the shell.
      shell: process.platform === "win32",
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

switch (cmd) {
  case "init":
    init(positionals()[0], flag("template", "vanilla"));
    break;
  case "build":
    build(process.cwd());
    break;
  case "dev":
    await dev(process.cwd());
    break;
  default:
    console.log(
      "usage: janela init <name> [--template vanilla|vue|react|svelte|solid]\n" +
        "       janela build | janela dev",
    );
    process.exit(cmd ? 1 : 0);
}
