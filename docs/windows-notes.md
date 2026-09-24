# Windows port notes

What the Windows lane actually required, and the two upstream landmines found
getting there. Verified on `windows-latest` in CI: build **and** run, exit 0.

## The toolchain is MinGW, not MSVC

scriptc's `resolveCc` only accepts `clang` or `zigcc`, and its Windows runtime
is written against mingw-w64, not the MSVC CRT. Two independent walls:

1. **`ssize_t`** — `scr_runtime.h` uses it; the MSVC CRT has no such type, so
   a stock MSVC-targeting `clang` cannot even compile scriptc's runtime.
2. **`nanosleep` / `clock_gettime` / `CLOCK_MONOTONIC`** — `scr_async.c` says
   it plainly: *"the idle sleep is nanosleep (mingw-w64 ships it, over
   Sleep)"*. Not in the MSVC CRT either.

**zig does not work as a substitute.** `zig cc -target x86_64-windows-gnu`
clears wall 1 (zig bundles mingw headers) but not wall 2: zig omits
winpthreads, so `clock_gettime`/`nanosleep` are declared but never defined.

So janela requires a clang whose **default target** is mingw — llvm-mingw,
MSYS2 clang64, WinLibs. On 0.0.36 that also meant no `SCRIPTC_CC`/
`SCRIPTC_TARGET` was needed: scriptc's default `clang` driver was already the
right one. 0.1.3 changed that default — see below.

## New in 0.1.3: a split-ABI Windows route, with no opt-out

scriptc 0.1.3 added `WINDOWS_X64_MSVC_TARGET`
(`@scriptc/compiler`'s `backend/targets.js:115-130`), a new default
LLVM-tier executable route that `nativeHostTarget` selects for **any**
win32+x64 host — pure host detection, no `SCRIPTC_TARGET` value picks
anything else (`targets.js:222`, `:246`). It links three things that were
never exercised together before:

1. **The program object is MSVC-flavored** — the LLVM helper is invoked with
   `--target x86_64-pc-windows-msvc` (`backend/native-codegen.js:247`).
2. **The runtime pack is zig-mingw-flavored** — `runtimePackPackage:
   "@scriptc/runtime-win32-x64-msvc"` ships objects prebuilt against zig's
   bundled mingw sysroot (`targets.js:120-121`'s own comment says so).
3. **The link is asked to be GNU** anyway — `backend/link-plan.js:18-21`
   rewrites the target to `x86_64-windows-gnu` before invoking the linker,
   default `zig` (`defaultLinker: "zig"`, `defaultLinkerArgs: ["cc"]`).

Upstream's own claim (`targets.js:120-121`) is that these two ABIs are
compatible — but that is only ever exercised with **zig** as the linker and
with **no externally supplied C++ object**. janela supplies both: a foreign
linker (llvm-mingw clang, previously pinned via `SCRIPTC_LINKER`) and a
foreign C++ object (`wvshim.obj`, compiled separately by llvm-mingw's
`clang++`). Neither zig-as-linker (zig's bundled `libc++` fails rebuilding
against the shim's mingw C++ symbols) nor llvm-mingw-clang-as-linker (still
mixing an MSVC-triple object and a zig-mingw runtime pack) reliably links
that combination — and there is no `SCRIPTC_TARGET` value that asks for a
plain mingw target instead, because none exists in `NATIVE_TARGETS`
(`targets.js:176-180`).

**The fix: force scriptc back onto its pre-0.1.3 legacy pipeline.**
`SCRIPTC_CC=clang` (`legacyCExecutablePathRequested`,
`backend/external-c.js:35-38`) makes `usesPrecompiledRuntimePack`
(`index.js:841-847`) return false, so the new LLVM-tier route
(`emitNativeProgramObject`, the runtime pack, `createNativeLinkPlan`) is
never reached at all. The `.ll` scriptc generates and the runtime C sources
go straight to `compileExternalC` → `compileC` with a plain `clang` driver
(`native-toolchain.js:449-457`) — on a host with llvm-mingw's clang on
`PATH`, that is the exact single-ABI route 0.0.36 always used, the one this
doc already documents as proven to build, link, and run. `SCRIPTC_LINKER`
becomes dead config on this route (`compileExecutableNative` never reaches
the linker plan), so it is no longer set.

janela pins this itself — `scriptcEnv()` in `packages/janela/bin/lib.mjs`
sets `SCRIPTC_CC=clang` for every scriptc invocation on `win32`, unless the
caller already set `SCRIPTC_CC` — rather than only in CI, since every
Windows user hits the same split-ABI route, not just the CI box.
`SCRIPTC_TARGET` must stay unset alongside it: `resolveCc` rejects the pair
(`native-toolchain.js:454-456`).

`SCRIPTC_CC` is scriptc's own *legacy / migration* switch
(`external-c.js:26-34`), not deprecated in the sense of "about to vanish" —
it is explicitly kill-switchable by upstream CI
(`SCRIPTC_LEGACY_C_PIPELINE=0`) and will outlive this release, but it is not
a permanent destination. **Retire this pin** once scriptc's win32 route can
link a foreign mingw C++ object end to end — tracked upstream as
[scriptc#367](https://github.com/vercel-labs/scriptc/issues/367) — and a
zig-based shim build has been validated (see "Debugging the link" below for
how that was ruled out for now).

See `scratchpad/issue-0.1.3-windows-zig.md` and the row in
[shims-to-retire.md](shims-to-retire.md).

### Debugging the link

scriptc's own error truncation makes this route unusually hard to debug:
`ffiNativeBuildDetail` (`index.js:198-205`) slices stderr to the first line
matching a fixed list of linker-error markers, and that list covers ld64's
plural `Undefined symbols`, GNU ld's `undefined reference to`, MSVC link's
`unresolved external symbol` and `lld-link: error` — but **not ld.lld's own
mingw/ELF spelling**, `ld.lld: error: undefined symbol: <name>` (singular).
So the first matching line ends up being the trailing `clang: error: linker
command failed`, and every real undefined-symbol line above it is discarded.
Worth reporting upstream; it blocks debugging any Windows/Linux lld link,
not just this one.

Two knobs recover the real diagnostics without an upstream fix:

- **A tee wrapper via `SCRIPTC_LINKER`.** `resolvePlatformLinker`
  (`backend/linker.js:20-22`) honours `SCRIPTC_LINKER` verbatim, resolved
  through `PATH` with `PATHEXT` expansion on win32 (`:32-34`). Point it at a
  `clangtee.cmd` on `PATH` that execs the real `clang` with `%*` and
  redirects stderr to stdout (`clang.exe %* 2>&1`) — `execFileAsync` then
  captures it as stdout, which `subprocessFailureDetail`
  (`native-toolchain.js:243-248`) appends under "compiler stdout:", *after*
  the marker `ffiNativeBuildDetail` slices on, so it survives. It must pass
  args through untouched: scriptc also probes the linker with
  `-print-prog-name=clang`, `-print-prog-name=ld`, `-###` and `-Wl,-t`
  (`linker.js:67`, `:145-147`). Only meaningful with `SCRIPTC_CC` unset,
  i.e. on the new (non-legacy) route.
- **`SCRIPTC_RUNTIME_PACK=0` as a bisector.** Honoured at `index.js:720` and
  `:843`. It disables the runtime-pack link route while keeping the LLVM
  helper's MSVC-triple program object, then links via `compileExternalC`
  with a synthetic `driver.c` (`index.js:746-757`). That fixes only the
  zig-sysroot half of the mismatch and leaves the MSVC-object half — useful
  to tell which half is at fault (if it links, the runtime pack was the
  culprit; if it still fails, the MSVC-triple object is), not to ship.

## Upstream scriptc bug: winpthreads is never linked

scriptc's runtime calls `clock_gettime` and `nanosleep`, which mingw declares
in `<time.h>` but implements in **libwinpthread**. scriptc's win32 link never
adds it (its win32 threading arm uses `CreateThread`, so it assumes no
pthreads dependency). The result:

```
ld.lld: error: undefined symbol: clock_gettime
>>> referenced by scr_lib.o:(scr_date_now)
ld.lld: error: undefined symbol: nanosleep
>>> referenced by scr_lib.o:(scr_atomics_wait)
```

Reproducible with **no janela involvement at all**:

```console
$ echo 'console.log("hi");' > hello.ts
$ scriptc build hello.ts -o hello.exe    # fails to link on Windows
```

janela works around it by adding `pthread` to the FFI manifest's
`system_libraries`, which is appended to the link. **Worth reporting
upstream** — plain `scriptc` on Windows cannot link at all without it, and the
fix belongs in scriptc's win32 link line.

**Status:** reported as [#255](https://github.com/vercel-labs/scriptc/issues/255),
fixed upstream by PR #367 "fix(windows): provide native timing shims", merged
2026-09-21 — **not in 0.1.3** (published 2026-09-18, before the fix landed).
The `system_libraries` workaround stays until a release carries it.

## WebView2

`webview.h`'s Win32 backend includes `WebView2.h`, which lives only in the
`Microsoft.Web.WebView2` nuget package — not the Windows SDK, and not vendored
in webview. The CLI fetches the package (a `.nupkg` is a zip) into
`.janela/cache/` on first build; `JANELA_WEBVIEW2_INCLUDE` overrides it.

MinGW also lacks `EventToken.h`, which that header needs — webview vendors a
replacement at `compatibility/mingw/include`, which the shim compile adds.

Linking `WebView2Loader.dll` is *not* required: webview.h falls back to its own
minimal loader, so nothing extra ships with the app.

## Debugging note

When a scriptc link fails it prints only clang's summary line
(`linker command failed with exit code 1`), which hides `ld.lld`'s actual
undefined-symbol list. The way through was to run the failing link in
isolation — first the shim object against a tiny `main`, then a bare
`scriptc build hello.ts` with no FFI — which is what localised the bug to
scriptc rather than janela.

## Diffs from the other platforms

| | macOS | Linux | Windows |
|---|---|---|---|
| shim compiler | `clang++` | `g++` | `clang++` (mingw) |
| shim artifact | `libwvshim.a` | `libwvshim.a` | `wvshim.obj` (no `ar` in an MSVC-ish toolchain; a lone object needs no archive index) |
| output | `<name>` + `.app` | `<name>` | `<name>.exe` |
| strip | yes | yes | yes (MinGW keeps DWARF in the `.exe`) |
| CI | build only | build + run (Xvfb) | build + run |
