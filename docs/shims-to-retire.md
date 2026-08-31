# Shims to retire

janela deliberately does not reimplement scriptc's standard library. Where we
have had to, the code below is a stopgap tied to a specific upstream issue —
each one should be deleted when that issue lands, not grown.

| What we carry | Why | Retire when |
|---|---|---|
| Ticker thread + tick-driven turn loop (`wv_tick_*`) | scriptc's event loop is parked inside the blocking `wv_run` for the app's life, so `await` / `setTimeout` / promise continuations never resume | [#260](https://github.com/vercel-labs/scriptc/issues/260) ships a pump entry point (`run_once`) — the ticker calls that instead, and host-side `await` starts working |
| Deferred-job pool (`wv_defer` / `wv_resolve`) | An invoke's answer often cannot be produced during the call that starts it (async commands; modal dialogs, which spin a nested loop) | Partly outlives #260 — dialogs will always need it — but async commands could move to native promises |
| Worker-thread file I/O (`wv_job_*` read/write) | scriptc's `fs/promises` reads inline (call time scales with file size), and `node:fs` is sync-only | [#260](https://github.com/vercel-labs/scriptc/issues/260) adds thread-pool fs; then `readFileAsync` becomes a thin wrapper |
| `+ 0` on every FFI call result | A bare FFI call as a complete initializer is silently miscompiled | **FIXED upstream** ([#21](https://github.com/vercel-labs/scriptc/issues/21) / scriptc PR #268), verified against their `main`. Delete when a release past 0.0.35 ships — 24 occurrences across 11 files, of which only `runtime/janela.ts` has real code sites; the rest is documentation and template comments that currently *teach* the gotcha |
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

## Verified against scriptc `main` (2026-08-31, commit 2b6e652)

Fixed upstream, awaiting an npm release past 0.0.35:

| Upstream fix | Ours | Effect when released |
|---|---|---|
| PR #268 — FFI calls in variable initializers | [#21](https://github.com/vercel-labs/scriptc/issues/21) | the `+ 0` convention goes away entirely (all three forms verified) |
| PR #267 — string self-concatenation | [#258](https://github.com/vercel-labs/scriptc/issues/258) | `s = s + c` is now linear, and faster than Node (400k appends: 1692 ms → 4 ms). Our push+join code stays correct; the *constraint* is gone |
| PR #266 — inline record assertions | [#262](https://github.com/vercel-labs/scriptc/issues/262) (1 of 3) | indexing an inline cast no longer crashes |
| PR #270 — reject callback re-entry | [#263](https://github.com/vercel-labs/scriptc/issues/263) | illegal re-entry now traps with `SC4026` through the panic sink. **Verified our design is not caught by it**: we only re-enter from a later turn of the host's own loop, which still runs unchanged |

Still unfixed on `main`, so these stay:

- `JSON.stringify(null)` and `Object.keys` on a generic mapped type still crash (`SC9001`) — two of #262's three cases; reported again after the close.
- Indexing a large non-ASCII string is still O(index) ([#261](https://github.com/vercel-labs/scriptc/issues/261)).
- Library mode still refuses `async`, and microtasks still never drain across host re-entries ([#265](https://github.com/vercel-labs/scriptc/issues/265)) — this is the one that would let `commandAsync` collapse into `command`.
- The Windows link line still omits winpthread ([#255](https://github.com/vercel-labs/scriptc/issues/255)), so the `pthread` entry stays; and the PE `Subsystem` patch stays until [#259](https://github.com/vercel-labs/scriptc/issues/259) / their PR #269 lands.
