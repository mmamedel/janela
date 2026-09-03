# Shims to retire

janela deliberately does not reimplement scriptc's standard library. Where we
have had to, the code below is a stopgap tied to a specific upstream issue —
each one should be deleted when that issue lands, not grown.

| What we carry | Why | Retire when |
|---|---|---|
| Ticker thread + tick-driven turn loop (`wv_tick_*`) | scriptc's event loop is parked inside the blocking `wv_run` for the app's life, so `await` / `setTimeout` / promise continuations never resume | [#260](https://github.com/vercel-labs/scriptc/issues/260) ships a pump entry point (`run_once`) — the ticker calls that instead, and host-side `await` starts working |
| Deferred-job pool (`wv_defer` / `wv_resolve`) | An invoke's answer often cannot be produced during the call that starts it (async commands; modal dialogs, which spin a nested loop) | Partly outlives #260 — dialogs will always need it — but async commands could move to native promises |
| Worker-thread file I/O (`wv_job_*` read/write) | scriptc's `fs/promises` reads inline (call time scales with file size), and `node:fs` is sync-only | [#260](https://github.com/vercel-labs/scriptc/issues/260) adds thread-pool fs; then `readFileAsync` becomes a thin wrapper |
| `pthread` in `system_libraries` on Windows | scriptc's win32 link line omits libwinpthread, so `clock_gettime`/`nanosleep` are undefined | [#255](https://github.com/vercel-labs/scriptc/issues/255) is fixed |
| Post-link PE `Subsystem` patch | No way to pass `-mwindows`; a console window otherwise sits behind the app | [#259](https://github.com/vercel-labs/scriptc/issues/259) gives us a linker-flag route |
| `strip` in `janela build` | Symbol tables are ~16% of the binary | Never — this one is legitimately ours |

## The boundary

Ours: the webview shim, the IPC protocol, window / dialog / app lifecycle, the
CLI, bundling, Vite integration. Nobody else is going to build these.

Theirs: the event loop, threading, `fs`, HTTP, timers. If we build these we own
a shadow standard library forever, and it diverges from upstream the day
upstream ships. When a change starts looking like stdlib work, file it instead
— and if a stopgap is unavoidable, keep it minimal and add a row here.

## Retired in 0.0.36 (released 2026-09-02, pinned 2026-09-03)

These are **fixed upstream, consumed here, and gone from the codebase.** The
row above each one used to describe is deleted, not softened.

| Upstream fix | Issue | What we deleted, and what it bought |
|---|---|---|
| PR #268 — FFI calls in variable initializers | [#21](https://github.com/vercel-labs/scriptc/issues/21) | The `+ 0` convention, entirely: 13 code sites in `runtime/janela.ts`, the generated `entry.ts` line in `bin/janela.mjs`, and — the part that mattered — the comment blocks in all five templates and `examples/demo` that *taught* the gotcha to every new project. A scaffolded app no longer contains the string. |
| PR #271 — per-program stdlib tree-shaking | [#256](https://github.com/vercel-labs/scriptc/issues/256) | Nothing to delete; it is pure payoff. **Desktop binaries fell 41–58%** (see the table in [`frontend.md`](frontend.md)). Desktop only — see the caveat below. |
| PR #267 — string self-concatenation | [#258](https://github.com/vercel-labs/scriptc/issues/258) | The *constraint* behind the drain's push+join, not the code. `s = s + c` is linear now. Re-measured at the drain's real shape (256 × 128 KB): push+join 4–5 ms vs concat 5–6 ms, so the push+join stays — it is no longer a workaround, just the faster of two correct options. |
| large-string indexing (0.0.36) | [#261](https://github.com/vercel-labs/scriptc/issues/261) | Indexing a large non-ASCII string is no longer O(index) — re-measured 2026-09-03: 200 probes spread across a 200 000-char `é` string, 0 ms. No shim existed; the runtime simply stops having to avoid the shape. |
| PR #266 — inline record assertions | [#262](https://github.com/vercel-labs/scriptc/issues/262) (case 1 of 3) | Indexing an inline cast no longer crashes. |
| PR #270 — reject callback re-entry | [#263](https://github.com/vercel-labs/scriptc/issues/263) | Illegal re-entry traps with `SC4026`. **Verified janela's design is not caught by it**: we only re-enter from a later turn of the host's own loop. |

**Why mobile did not shrink on the bump, and what we did about it.** The
elimination is section-based dead-stripping applied **at scriptc's own
executable link step** — `executableSectionEliminationFlags` in
`backend/native-toolchain.js` returns `-Wl,-dead_strip` on darwin and
`-ffunction-sections -fdata-sections` + `-Wl,--gc-sections` on linux. iOS and
Android are the only lanes that build in *library* mode: scriptc emits a static
archive and janela performs the final link, so scriptc's dead-strip never runs
on them. Its own note says so: "`--lib` preserves its established object and
archive contract; section GC is an executable-link optimization only."

That makes the stripping **ours**, not a shim awaiting upstream, and 0.14.1
does it: `-Wl,-dead_strip` on the iOS link, and `-Wl,--gc-sections
-Wl,--exclude-libs,ALL` on the Android one (`--exclude-libs` is the load-bearing
half — without it every default-visibility symbol in the archive is a GC root
and only 51 KB comes back). iOS `.app` 409,232 → 232,208 and the Android `.so`
1,406,488 → 852,720, a constant saving across all five templates. The dead
`scr_path_win32_*` / `scr_exec_*` symbols the desktop link had already dropped
are now gone from both mobile lanes too.

One slice is still upstream's, and is a genuine lane gap: `compileLibArchive`
does not pass `-ffunction-sections -fdata-sections`, so ELF GC works per
translation unit rather than per function. With them the Android `.so` reaches
674,616 — another **178 KB** — and the change is byte-identical for any consumer
who does not pass `--gc-sections`.

## Still carried, with the issue that would let us delete it

| What we carry | Why | Retire when |
|---|---|---|
| Avoid `JSON.stringify(null)` | A bare unit literal still crashes the compiler on 0.0.36: `SC9001: internal compiler error: in %init.0: bare unitLit 'null' outside a unionWrap`. One of [#262](https://github.com/vercel-labs/scriptc/issues/262)'s three cases, reported again after the close | #262's remaining case lands |
| Avoid `Object.keys` on a *generic mapped type* | Still unsupported, but **no longer a crash** — 0.0.36 reports `SC2020: 'Object.keys' … has no scriptc lowering yet`. Verified 2026-09-03: `{ [K in keyof T]: … }` through a generic fails; `Object.keys` on a plain record compiles and runs | scriptc lowers `Object.keys` for mapped types |
| Post-link PE `Subsystem` patch | No way to pass `-mwindows`; a console window otherwise sits behind the app | [#259](https://github.com/vercel-labs/scriptc/issues/259) gives us a linker-flag route. Their PR #269 was **closed unmerged**, so this one has no landing date |
| `pthread` in `system_libraries` on Windows | scriptc's win32 link line still omits libwinpthread, so `clock_gettime` / `nanosleep` are undefined. Re-checked in 0.0.36: `native-toolchain.js` passes `-pthread` for POSIX drivers and `[]` for `win32` (its own code uses `CreateThread`), so our shim's POSIX time calls have nothing to link against | [#255](https://github.com/vercel-labs/scriptc/issues/255) is fixed |

Unchanged from before, and unaffected by 0.0.36: library mode still refuses
`async`, and microtasks still never drain across host re-entries
([#265](https://github.com/vercel-labs/scriptc/issues/265)) — that is the one
that would let `commandAsync` collapse into `command`.
