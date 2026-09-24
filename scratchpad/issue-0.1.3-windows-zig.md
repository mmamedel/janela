# windows-x64-msvc's default executable link now hard-requires a `zig` binary, undocumented

**Package:** `@scriptc/compiler@0.1.3` (via `scriptc@0.1.3`).

**Error:**
```
error SC5004: FFI native build failed: zig failed while building the generated program:
spawn zig ENOENT
```

**Environment:** `windows-latest` GitHub Actions runner, Node 24, llvm-mingw clang on
`PATH` (previously sufficient), no `zig` binary installed, `SCRIPTC_CC`/`SCRIPTC_TARGET`
unset. Reproduces on every desktop build, not just FFI-manifest ones.

**Root cause:** `WINDOWS_X64_MSVC_TARGET` in `backend/targets.js` sets
`defaultLinker: "zig"`, `defaultLinkerArgs: ["cc"]` — the new default LLVM-tier
executable route (introduced in 0.1.3) links the target's precompiled runtime pack,
built against zig's own mingw sysroot, through a bare `zig` binary resolved from
`PATH`/`SCRIPTC_LINKER`. This is new: 0.1.3 is the first release with a
`@scriptc/llvm-win32-x64-msvc` helper package at all (0.0.36 had no Windows native
helper). `SCRIPTC_CC=clang` does not avoid this — per the README, that env var now only
selects the deprecated legacy generated-C pipeline, not this link route.

**Ask:** either document the new Windows `zig` prerequisite (a stock llvm-mingw clang
install, previously sufficient per your own docs, no longer is), or vendor a `zig`
binary the same way the LLVM codegen helpers are vendored (an optional
`@scriptc/zig-win32-x64` package, or similar), so `windows-x64-msvc` needs no additional
manual toolchain install.

**Workaround in use:** pinned `zig` install step in CI (`mlugg/setup-zig@v2`, version
0.16.0), tracked in `docs/shims-to-retire.md` and `docs/windows-notes.md`.
