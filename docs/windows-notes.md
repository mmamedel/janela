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
MSYS2 clang64, WinLibs. That also means no `SCRIPTC_CC`/`SCRIPTC_TARGET` is
needed: scriptc's default `clang` driver is already the right one.

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
