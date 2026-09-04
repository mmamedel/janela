import { createHash } from "node:crypto";
/**
 * Pure helpers shared by the CLI and its tests.
 *
 * `bin/janela.mjs` is build orchestration: it shells out, writes files and
 * exits. The decisions inside it — how a name is validated, how a config's
 * defaults fall back, which symbols an FFI manifest must declare, which bytes
 * of a PE may be rewritten — are pure, and a wrong answer from any of them
 * fails quietly rather than loudly: a missing FFI declaration makes the
 * runtime fail to link, and a mis-coerced Android id is rejected by aapt2
 * only at package time.
 *
 * So they live here, where a test can call them directly. Nothing in this
 * file touches the filesystem, the network or a subprocess.
 */

import { join } from "node:path";

// ---- project names ---------------------------------------------------------

export const NAME_RE = /^[a-z][a-z0-9_-]*$/;

export const MIME = {
  ".css": "text/css", ".js": "text/javascript", ".json": "application/json",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif",
  ".svg": "image/svg+xml", ".ico": "image/x-icon",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf",
  ".mp3": "audio/mpeg", ".mp4": "video/mp4", ".webm": "video/webm",
};
export const STR = (name, symbol) => ({ name, symbol, params: ["i32", "string"], returns: "i32" });
export const IOS_MIN_VERSION = "15.0";
export const IOS_PREFIX = "jl_";
export const ANDROID_MIN_SDK = 26;
export const ANDROID_TARGET_SDK = 34;
export const ANDROID_ABI = "arm64-v8a";
export const IMAGE_SUBSYSTEM_WINDOWS_GUI = 2;
export const IMAGE_SUBSYSTEM_WINDOWS_CUI = 3;

export function suggestName(raw) {
  const s = String(raw)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .replace(/-{2,}/g, "-")
    .replace(/[-_]+$/, "");
  return NAME_RE.test(s) ? s : "";
}

export function androidPackage(id) {
  return id
    .split(".")
    .map((seg) => {
      const cleaned = seg.replace(/[^A-Za-z0-9_]/g, "_");
      return /^[A-Za-z_]/.test(cleaned) ? cleaned : `_${cleaned}`;
    })
    .join(".");
}

export function androidConf(conf) {
  const a = conf.android ?? {};
  return {
    applicationId: androidPackage(a.applicationId ?? a.identifier ?? conf.identifier),
    label: a.label ?? conf.window?.title ?? conf.name,
    minSdk: String(a.minSdk ?? ANDROID_MIN_SDK),
    device: a.device ?? null,
  };
}

export function iosConf(conf) {
  const ios = conf.ios ?? {};
  return {
    identifier: ios.identifier ?? conf.identifier,
    displayName: ios.displayName ?? conf.window?.title ?? conf.name,
    minimumVersion: String(ios.minimumVersion ?? IOS_MIN_VERSION),
    device: ios.device ?? null,
  };
}

export function libraryProfile() {
  return {
    profile_format: 1,
    name: "janela",
    entry: "./entry.ts",
    emission: "llvm",
    abi: {
      prefix: IOS_PREFIX,
      init_symbol: `${IOS_PREFIX}init`,
      sink_register_symbol: `${IOS_PREFIX}set_panic_sink`,
      collect_symbol: `${IOS_PREFIX}collect`,
      result_reset_symbol: `${IOS_PREFIX}reset`,
      callback_register_symbol: `${IOS_PREFIX}set_callback`,
    },
    exports: [
      {
        export: "handleInvoke",
        symbol: `${IOS_PREFIX}handle_invoke`,
        params: ["string", "string"],
        returns: "string",
      },
      {
        export: "indexHtml",
        symbol: `${IOS_PREFIX}index_html`,
        params: [],
        returns: "string",
      },
      // The shell calls these back on the main queue when work it owns comes
      // due. They are the mirror of the desktop shim's wv_on_timer: the
      // library parks a continuation under an id and is re-entered with it.
      {
        export: "onTimer",
        symbol: `${IOS_PREFIX}on_timer`,
        params: ["f64"],
        returns: "void",
      },
      {
        export: "onFsDone",
        symbol: `${IOS_PREFIX}on_fs_done`,
        params: ["f64", "bool", "string"],
        returns: "void",
      },
      // Deliberately its own export rather than reusing onFsDone, whose
      // signature would fit: a dialog result arriving through the file-I/O
      // path would read as a bug for as long as the code lived.
      {
        export: "onDialogDone",
        symbol: `${IOS_PREFIX}on_dialog_done`,
        params: ["f64", "bool", "string"],
        returns: "void",
      },
    ],
    // TS -> shell. A channel handler must never re-enter the library (see
    // upstream #263: violations silently appear to work), so every one of
    // these only records the request; the shell acts on its own queue and
    // re-enters through an export above on a later turn.
    callbacks: [
      { name: "janelaEmit", params: ["string", "string"], returns: "void" },
      { name: "hostSchedule", params: ["f64", "f64"], returns: "void" },
      { name: "hostSettle", params: ["f64", "string"], returns: "void" },
      { name: "hostReadFile", params: ["f64", "string"], returns: "void" },
      { name: "hostWriteFile", params: ["f64", "string", "string"], returns: "void" },
      { name: "hostOpenDialog", params: ["f64", "string"], returns: "void" },
    ],
  };
}

export function mimeFor(p) {
  const dot = p.lastIndexOf(".");
  return (dot < 0 ? null : MIME[p.slice(dot).toLowerCase()]) ?? "application/octet-stream";
}

/**
 * The FFI manifest a desktop build hands to scriptc: every shim symbol the
 * runtime calls, plus the per-platform link inputs.
 *
 * `platform` and `macSdkPath` are parameters rather than ambient lookups so
 * that every branch is reachable from any host — a manifest that silently
 * loses a declaration fails at link time, on one platform, which is the worst
 * place to find out.
 */
export function ffiManifest(shimLib, { platform = process.platform, macSdkPath = null } = {}) {
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
      name: "wvOnTimer", symbol: "wv_on_timer",
      params: [
        "i32",
        { callback: { id: "timer", params: ["i32", { context: "timer" }], returns: "void", lifetime: "retained" } },
        { context: "timer" },
      ],
      returns: "i32",
    },
    { name: "wvRun", symbol: "wv_run", params: ["i32"], returns: "i32" },
    { name: "wvTerminate", symbol: "wv_terminate", params: ["i32"], returns: "i32" },
    // async: the held-reply table (deferred returns) plus shell-owned
    // scheduling — TS parks a continuation id, the shell calls it back due.
    { name: "wvDefer", symbol: "wv_defer", params: ["i32"], returns: "i32" },
    { name: "wvResolve", symbol: "wv_resolve", params: ["i32", "i32", "i32"], returns: "i32" },
    { name: "wvSchedule", symbol: "wv_schedule", params: ["i32", "i32", "i32"], returns: "i32" },
    // async file I/O: the blocking syscall runs on a shim worker thread
    { name: "wvFsRead", symbol: "wv_fs_read", params: ["i32", "string"], returns: "i32" },
    { name: "wvFsWrite", symbol: "wv_fs_write", params: ["i32", "string", "string"], returns: "i32" },
    // Job accessors, shared by file I/O and dialogs: both are work whose
    // answer cannot be produced during the FFI call that starts it.
    { name: "wvJobStatus", symbol: "wv_job_status", params: ["i32", "i32"], returns: "i32" },
    { name: "wvJobSize", symbol: "wv_job_size", params: ["i32", "i32"], returns: "f64" },
    {
      // One slice per call, so a large payload decodes across several UI turns
      // instead of stalling on all of it at once. Returns the bytes covered.
      name: "wvJobTakeAt", symbol: "wv_job_take_at",
      params: [
        "i32", "i32", "f64", "f64",
        { callback: { id: "sink", params: ["string", { context: "sink" }], returns: "void", lifetime: "call" } },
        { context: "sink" },
      ],
      returns: "f64",
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
    STR("wvSetMenu", "wv_set_menu"),
    // Retained like wvOnInvoke: registered once, valid until the app exits.
    // The clicked item's id rides in as a `string` param (format 3).
    {
      name: "wvOnMenu", symbol: "wv_on_menu",
      params: [
        "i32",
        { callback: { id: "menu", params: ["string", { context: "menu" }], returns: "i32", lifetime: "retained" } },
        { context: "menu" },
      ],
      returns: "i32",
    },
  ];

  if (platform === "win32") {
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
        // GetOpenFileNameW / GetSaveFileNameW for the native file dialogs.
        "comdlg32",
      ],
    };
  }

  if (platform === "darwin") {
    // scriptc has no -framework support, but `libraries` entries are passed to
    // the link as plain input files and ld64 accepts .tbd stubs.
    if (!macSdkPath) throw new Error("ffiManifest: macSdkPath is required on darwin");
    const sdk = macSdkPath;
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
// ---- host specifier rewrite -------------------------------------------------

/**
 * Rewrite a project's `from "janela/host"` to the runtime copy the CLI places
 * beside it in `.janela/build/`.
 *
 * A project imports the package specifier so that it resolves in an editor
 * against the installed package; the build compiles against the local copy
 * instead, which keeps it static (no node_modules resolution) and keeps
 * working once "janela/host" exports values and not only types.
 *
 * Deliberately narrow: only a specifier in `from` position, only that exact
 * module, either quote style. A mention inside a comment or a longer
 * specifier such as "janela/host-extras" is left alone.
 */
export function rewriteHostSpecifier(src) {
  return src.replace(/(\bfrom\s*)(['"])janela\/host\2/g, "$1$2./janela$2");
}

// ---- Windows subsystem ------------------------------------------------------

/** A PE the patcher refused to touch, with `code` naming the reason. */
export class PeError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * Flip a console-subsystem PE to the GUI subsystem, in place, on a copy of
 * the caller's buffer.
 *
 * Returns `{ patched: false }` when the image is already GUI, or
 * `{ patched: true, buf }` with the rewritten bytes. Anything that does not
 * look like the console-subsystem PE we just linked throws a `PeError`
 * instead of being modified — the whole point is to touch exactly one field
 * of exactly one shape of file.
 */
export function patchPeSubsystem(input) {
  const buf = Buffer.from(input);
  if (buf.length < 0x40 || buf.readUInt16LE(0) !== 0x5a4d) {
    throw new PeError("no-mz", "not a PE image (no MZ header)");
  }
  const peOff = buf.readUInt32LE(0x3c);
  if (peOff + 24 > buf.length || buf.readUInt32LE(peOff) !== 0x00004550) {
    throw new PeError("no-pe", `no PE signature at ${peOff}`);
  }
  // Optional header starts after the 4-byte signature and 20-byte COFF header;
  // Subsystem sits at +68 in both PE32 (0x10b) and PE32+ (0x20b).
  const optOff = peOff + 24;
  const magic = buf.readUInt16LE(optOff);
  if (magic !== 0x10b && magic !== 0x20b) {
    throw new PeError("bad-magic", `unrecognised optional header magic 0x${magic.toString(16)}`);
  }
  const subOff = optOff + 68;
  if (subOff + 2 > buf.length) {
    throw new PeError("truncated", "truncated before its Subsystem field");
  }
  const current = buf.readUInt16LE(subOff);
  if (current === IMAGE_SUBSYSTEM_WINDOWS_GUI) return { patched: false };
  if (current !== IMAGE_SUBSYSTEM_WINDOWS_CUI) {
    throw new PeError("unexpected-subsystem", `unexpected subsystem ${current}; refusing to rewrite it`);
  }
  buf.writeUInt16LE(IMAGE_SUBSYSTEM_WINDOWS_GUI, subOff);
  return { patched: true, buf };
}

/**
 * Which package manager to install a scaffolded project with.
 *
 * `npm_config_user_agent` is set by whichever manager ran janela, so
 * `pnpm janela init` installs with pnpm. Run as a plain global binary it is
 * unset, and npm is the only manager guaranteed to exist alongside node.
 *
 * Takes the environment rather than reading process.env, so it is testable.
 */
export function packageManager(env = {}) {
  const ua = env.npm_config_user_agent ?? "";
  for (const pm of ["pnpm", "yarn", "bun"]) if (ua.startsWith(`${pm}/`)) return pm;
  return "npm";
}

/**
 * The install invocation for a manager.
 *
 * yarn's is the bare command. npm gets --no-fund --no-audit: neither is useful
 * on a freshly scaffolded tree, and the audit is the slowest part of it.
 */
export function installCommand(pm) {
  if (pm === "yarn") return ["yarn"];
  if (pm === "npm") return ["npm", "install", "--no-fund", "--no-audit"];
  return [pm, "install"];
}

/**
 * The cache key for the compiled webview shim.
 *
 * Keyed on the shim's CONTENT, not its mtime. The mtime test this replaced was
 * wrong in the one case that matters — upgrading janela: pnpm's store is
 * content-addressed and hard-links files into node_modules carrying the
 * STORE's mtime, which is older than an object compiled minutes earlier from
 * the previous version. The cache then looked fresh, the stale archive was
 * reused, and the link failed naming symbols the new shim exports and the old
 * object does not.
 *
 * `version` is in the key so a shim that happens to be byte-identical across
 * releases still recompiles when anything else about the build moved.
 */
export function shimCacheKey(source, version, platform, includeFlag) {
  return createHash("sha256")
    .update(source)
    .update(`\u0000${version}\u0000${platform}\u0000${includeFlag}`)
    .digest("hex");
}
