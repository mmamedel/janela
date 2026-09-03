/**
 * Unit tests for the CLI's pure decisions (packages/janela/bin/lib.mjs).
 *
 * Each of these fails quietly in production if it is wrong: a mis-coerced
 * Android id is rejected by aapt2 only at package time, a missing FFI
 * declaration makes the compiled runtime fail to link, and a name rule that
 * drifts silently changes what `janela init` accepts.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  androidConf, androidPackage, ffiManifest, iosConf, libraryProfile, mimeFor,
  NAME_RE, patchPeSubsystem, PeError, rewriteHostSpecifier, suggestName,
  installCommand,
  packageManager,
} from "../../bin/lib.mjs";

// ---- project names ---------------------------------------------------------
//
// Underscores are accepted deliberately: every downstream consumer takes them,
// and an Android application id (a Java package name) cannot contain a hyphen,
// so `_` is the better input there. A rejected name used to be far worse than
// it looks — the scaffold failed, a following `cd` failed, and a `grep -c` over
// the empty output reported "0 errors", so a script read the whole thing as a
// pass.

test("accepts the names janela init documents", () => {
  for (const n of ["a", "my-app", "my_app", "app2", "a-b_c9"]) {
    assert.ok(NAME_RE.test(n), `${n} should be accepted`);
  }
});

test("rejects names that are not usable as a directory or identifier", () => {
  for (const n of ["My App", "9lives", "-leading", "_leading", "has space", "dots.here", "", "UPPER"]) {
    assert.ok(!NAME_RE.test(n), `${n} should be rejected`);
  }
});

test("suggestName repairs a rejected name into an accepted one", () => {
  for (const [raw, want] of [["My App", "my-app"], ["9lives", "lives"], ["a--b", "a-b"], ["trailing-", "trailing"]]) {
    assert.equal(suggestName(raw), want);
    assert.ok(NAME_RE.test(suggestName(raw)), "a suggestion must itself be accepted");
  }
});

test("suggestName gives up rather than suggesting something invalid", () => {
  // "!!!" has nothing to keep; the caller prints the rule alone instead.
  assert.equal(suggestName("!!!"), "");
});

// ---- Android application ids -----------------------------------------------

test("androidPackage coerces each segment to a Java identifier", () => {
  assert.equal(androidPackage("dev.janela.my-app"), "dev.janela.my_app");
  assert.equal(androidPackage("a.b-c.d"), "a.b_c.d");
});

test("androidPackage prefixes a segment that would start with a digit", () => {
  // `dev.janela.9lives` is not a legal Java package name; aapt2 rejects it.
  assert.equal(androidPackage("dev.janela.9lives"), "dev.janela._9lives");
});

test("androidPackage leaves an already-legal id untouched", () => {
  assert.equal(androidPackage("com.example.app"), "com.example.app");
});

// ---- config defaults -------------------------------------------------------

test("iosConf falls back through window.title to name", () => {
  const base = { name: "proj", identifier: "dev.x.proj", window: { title: "Title" } };
  assert.deepEqual(iosConf(base), {
    identifier: "dev.x.proj", displayName: "Title", minimumVersion: "15.0", device: null,
  });
  assert.equal(iosConf({ name: "proj", identifier: "i" }).displayName, "proj");
});

test("iosConf lets an explicit ios section win", () => {
  const c = {
    name: "proj", identifier: "dev.x.proj", window: { title: "Title" },
    ios: { identifier: "dev.x.ios", displayName: "iOS Name", minimumVersion: 16, device: "iPhone 17 Pro" },
  };
  assert.deepEqual(iosConf(c), {
    identifier: "dev.x.ios", displayName: "iOS Name", minimumVersion: "16", device: "iPhone 17 Pro",
  });
});

test("androidConf coerces the derived id and falls back for the label", () => {
  const c = { name: "my-app", identifier: "dev.janela.my-app", window: { title: "My App" } };
  assert.deepEqual(androidConf(c), {
    applicationId: "dev.janela.my_app", label: "My App", minSdk: "26", device: null,
  });
});

test("androidConf coerces an explicitly configured id too", () => {
  const c = {
    name: "n", identifier: "dev.x.n", window: { title: "T" },
    android: { applicationId: "com.acme.my-app", label: "Acme", minSdk: 30 },
  };
  assert.deepEqual(androidConf(c), {
    applicationId: "com.acme.my_app", label: "Acme", minSdk: "30", device: null,
  });
});

// ---- host specifier rewrite -------------------------------------------------
//
// A project imports "janela/host" so it resolves in an editor; the build
// compiles against the copy placed beside it, which is what keeps the build
// static (no node_modules resolution) and will keep working when the specifier
// starts exporting values as well as types.

test("rewriteHostSpecifier redirects the package specifier to the local copy", () => {
  assert.equal(
    rewriteHostSpecifier('import type { JanelaApp } from "janela/host";'),
    'import type { JanelaApp } from "./janela";',
  );
  assert.equal(
    rewriteHostSpecifier("import { defineCommands } from 'janela/host';"),
    "import { defineCommands } from './janela';",
  );
});

test("rewriteHostSpecifier rewrites every import in a file", () => {
  const src = 'from "janela/host"\nfrom "janela/host"\n';
  assert.equal(rewriteHostSpecifier(src), 'from "./janela"\nfrom "./janela"\n');
});

test("rewriteHostSpecifier leaves lookalikes alone", () => {
  // A longer specifier, and a mention that is not in `from` position.
  assert.equal(
    rewriteHostSpecifier('import x from "janela/host-extras";'),
    'import x from "janela/host-extras";',
  );
  assert.equal(
    rewriteHostSpecifier('const s = "janela/host";'),
    'const s = "janela/host";',
  );
});

// ---- FFI manifest ----------------------------------------------------------
//
// Every symbol the compiled runtime calls must be declared here. A missing
// entry is not a type error and not a build error: the link fails, on one
// platform, with an undefined symbol.

const SHIM = "/tmp/libwvshim.a";

/** The shim symbols runtime/janela.ts calls; see its `declare function` block. */
const REQUIRED = [
  "wvCreate", "wvSetTitle", "wvSetSize", "wvSetHtml", "wvInit", "wvEval",
  "wvBind", "wvReply", "wvOnInvoke", "wvRun", "wvTerminate", "wvSchedule",
  "wvOnTimer", "wvDefer", "wvResolve", "wvJobSize", "wvJobTakeAt", "wvJobFree",
  "wvFsRead", "wvFsWrite", "wvDialog", "wvSetFullscreen",
];

for (const platform of ["darwin", "win32", "linux"]) {
  test(`ffiManifest declares every shim symbol on ${platform}`, () => {
    const m = ffiManifest(SHIM, { platform, macSdkPath: "/SDK" });
    const declared = new Set(m.functions.map((f) => f.name));
    for (const name of REQUIRED) {
      assert.ok(declared.has(name), `${platform}: ${name} is not declared — the link would fail`);
    }
  });

  test(`ffiManifest entries are well-formed on ${platform}`, () => {
    const m = ffiManifest(SHIM, { platform, macSdkPath: "/SDK" });
    assert.equal(m.ffi_format, 4);
    assert.ok(m.libraries.includes(SHIM), "the shim archive must be linked");
    for (const f of m.functions) {
      assert.ok(f.name && f.symbol, `every entry needs a name and a symbol: ${JSON.stringify(f)}`);
      assert.ok(Array.isArray(f.params), `${f.name}: params must be an array`);
      assert.ok(f.returns, `${f.name}: a return type is required`);
    }
  });
}

test("ffiManifest links the WebKit and Cocoa stubs on darwin", () => {
  // scriptc has no -framework support; ld64 accepts .tbd stubs as plain inputs.
  const m = ffiManifest(SHIM, { platform: "darwin", macSdkPath: "/SDK" });
  assert.ok(m.libraries.some((l) => l.includes("WebKit.tbd")));
  assert.ok(m.libraries.some((l) => l.includes("Cocoa.tbd")));
});

test("ffiManifest refuses to guess the macOS SDK path", () => {
  assert.throws(() => ffiManifest(SHIM, { platform: "darwin" }), /macSdkPath is required/);
});

test("ffiManifest keeps the Windows workaround libraries", () => {
  const m = ffiManifest(SHIM, { platform: "win32" });
  // comdlg32 backs the native file dialogs. `pthread` works around scriptc
  // calling clock_gettime/nanosleep without linking mingw's winpthreads
  // (upstream issue #255) — dropping it breaks the link with an undefined
  // symbol, in a plain build with no FFI involved.
  for (const lib of ["comdlg32", "pthread", "c++"]) {
    assert.ok(m.system_libraries.includes(lib), `win32 needs ${lib}`);
  }
});

test("ffiManifest links the GTK/WebKitGTK stack on linux", () => {
  const m = ffiManifest(SHIM, { platform: "linux" });
  for (const lib of ["webkit2gtk-4.1", "gtk-3", "pthread"]) {
    assert.ok(m.system_libraries.includes(lib), `linux needs ${lib}`);
  }
});

// ---- library profile (mobile) ----------------------------------------------

test("libraryProfile declares the mobile ABI the shells call", () => {
  const p = libraryProfile();
  assert.equal(p.profile_format, 1);
  assert.equal(p.emission, "llvm");
  assert.ok(p.abi.prefix, "the ABI needs a symbol prefix");
  assert.ok(p.abi.init_symbol.startsWith(p.abi.prefix), "init must carry the prefix");
  const exported = new Set(p.exports.map((e) => e.export));
  // handleInvoke carries every user command; the rest are the shell's hooks.
  assert.ok(exported.has("handleInvoke"), "handleInvoke is the one command entry point");
  for (const e of p.exports) {
    assert.ok(e.symbol.startsWith(p.abi.prefix), `${e.export}: symbol must carry the ABI prefix`);
  }
});

// ---- PE subsystem patch ----------------------------------------------------
//
// scriptc exposes no way to pass -mwindows, so `janela build` rewrites the
// subsystem byte of the linked PE. It is the one place janela edits a compiler
// artifact, so it validates every offset first and refuses anything that is
// not the console-subsystem PE it just produced.

/** A minimal PE, valid enough for the fields the patcher reads. */
function fakePe({ magic = 0x10b, subsystem = 3, peOff = 0x80, size = 0x200 } = {}) {
  const buf = Buffer.alloc(size);
  buf.write("MZ", 0, "ascii");
  buf.writeUInt32LE(peOff, 0x3c);
  buf.writeUInt32LE(0x00004550, peOff);          // "PE\0\0"
  buf.writeUInt16LE(magic, peOff + 24);          // optional header magic
  buf.writeUInt16LE(subsystem, peOff + 24 + 68); // Subsystem
  return buf;
}

test("patchPeSubsystem flips a console PE to GUI", () => {
  const buf = fakePe({ subsystem: 3 });
  const r = patchPeSubsystem(buf);
  assert.equal(r.patched, true);
  assert.equal(r.buf.readUInt16LE(0x80 + 24 + 68), 2, "subsystem must now be GUI");
});

test("patchPeSubsystem works for PE32+ as well as PE32", () => {
  const r = patchPeSubsystem(fakePe({ magic: 0x20b }));
  assert.equal(r.patched, true);
});

test("patchPeSubsystem leaves the caller's buffer untouched", () => {
  const buf = fakePe();
  patchPeSubsystem(buf);
  assert.equal(buf.readUInt16LE(0x80 + 24 + 68), 3, "the input must not be mutated in place");
});

test("patchPeSubsystem is a no-op on an already-GUI image", () => {
  assert.deepEqual(patchPeSubsystem(fakePe({ subsystem: 2 })), { patched: false });
});

test("patchPeSubsystem refuses anything that is not the PE it expects", () => {
  const cases = [
    ["no-mz", Buffer.alloc(0x200)],
    ["no-mz", Buffer.from("hello")],
    ["bad-magic", fakePe({ magic: 0x999 })],
    ["unexpected-subsystem", fakePe({ subsystem: 9 })],
  ];
  for (const [code, buf] of cases) {
    assert.throws(() => patchPeSubsystem(buf), (e) => {
      assert.ok(e instanceof PeError, "must be a PeError");
      assert.equal(e.code, code);
      return true;
    }, `expected ${code}`);
  }
});

test("patchPeSubsystem refuses a PE header pointing outside the file", () => {
  const buf = fakePe();
  buf.writeUInt32LE(0xfffff, 0x3c);
  assert.throws(() => patchPeSubsystem(buf), (e) => e.code === "no-pe");
});

test("patchPeSubsystem refuses a file truncated before Subsystem", () => {
  // Every header offset is still valid; the file simply ends inside the
  // Subsystem field. Built whole and then cut, because a buffer too short to
  // hold the field is also too short to write the headers into.
  const subOff = 0x80 + 24 + 68;
  const buf = fakePe().subarray(0, subOff + 1);
  assert.throws(() => patchPeSubsystem(buf), (e) => {
    assert.equal(e.code, "truncated");
    return true;
  });
});

// ---- misc ------------------------------------------------------------------

test("mimeFor maps the asset types the Vite inliner embeds", () => {
  assert.equal(mimeFor("/a/b/app.css"), "text/css");
  assert.equal(mimeFor("logo.SVG"), "image/svg+xml");        // case-insensitive
  assert.equal(mimeFor("font.woff2"), "font/woff2");
  assert.equal(mimeFor("noextension"), "application/octet-stream");
  assert.equal(mimeFor("archive.tar.gz"), "application/octet-stream");
});

// `janela init` installs a scaffolded project's dependencies, and which
// manager it uses is inferred from the one that ran janela. Getting this wrong
// is quiet and annoying: pnpm users would get an npm lockfile in a pnpm repo.
test("the package manager is the one that invoked janela", () => {
  assert.equal(packageManager({ npm_config_user_agent: "pnpm/9.1.0 npm/? node/v24.0.0" }), "pnpm");
  assert.equal(packageManager({ npm_config_user_agent: "yarn/4.1.0 npm/? node/v24.0.0" }), "yarn");
  assert.equal(packageManager({ npm_config_user_agent: "bun/1.1.0" }), "bun");
  assert.equal(packageManager({ npm_config_user_agent: "npm/10.9.0 node/v24.0.0" }), "npm");
});

test("no user agent means npm — the only manager node guarantees", () => {
  // Run as a global binary rather than through a package script, which is how
  // `janela init` is normally invoked.
  assert.equal(packageManager({}), "npm");
  assert.equal(packageManager(), "npm");
});

test("a manager whose name merely starts a known one is not mistaken for it", () => {
  // The prefix is matched with the trailing slash for a reason: without it
  // "pnpmx/1.0" would install with pnpm.
  assert.equal(packageManager({ npm_config_user_agent: "pnpmx/1.0.0" }), "npm");
  assert.equal(packageManager({ npm_config_user_agent: "yarnpkg-alt/1.0.0" }), "npm");
});

test("each manager's install invocation is the one it actually accepts", () => {
  // `yarn install` works but `yarn` is the documented form; npm skips fund and
  // audit, neither of which says anything useful about a tree created seconds
  // ago, and the audit is the slow half.
  assert.deepEqual(installCommand("yarn"), ["yarn"]);
  assert.deepEqual(installCommand("pnpm"), ["pnpm", "install"]);
  assert.deepEqual(installCommand("bun"), ["bun", "install"]);
  assert.deepEqual(installCommand("npm"), ["npm", "install", "--no-fund", "--no-audit"]);
});
