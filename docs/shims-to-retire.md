# Shims to retire

janela deliberately does not reimplement scriptc's standard library. Where we
have had to, the code below is a stopgap tied to a specific upstream issue —
each one should be deleted when that issue lands, not grown.

| What we carry | Why | Retire when |
|---|---|---|
| Ticker thread + tick-driven turn loop (`wv_tick_*`) | scriptc's event loop is parked inside the blocking `wv_run` for the app's life, so `await` / `setTimeout` / promise continuations never resume | [#260](https://github.com/vercel-labs/scriptc/issues/260) ships a pump entry point (`run_once`) — the ticker calls that instead, and host-side `await` starts working |
| Deferred-job pool (`wv_defer` / `wv_resolve`) | An invoke's answer often cannot be produced during the call that starts it (async commands; modal dialogs, which spin a nested loop) | Partly outlives #260 — dialogs will always need it — but async commands could move to native promises |
| Worker-thread file I/O (`wv_job_*` read/write) | scriptc's `fs/promises` reads inline (call time scales with file size), and `node:fs` is sync-only | [#260](https://github.com/vercel-labs/scriptc/issues/260) adds thread-pool fs; then `readFileAsync` becomes a thin wrapper |
| `+ 0` on every FFI call result | A bare FFI call as a complete initializer is silently miscompiled | [#21](https://github.com/vercel-labs/scriptc/issues/21) is fixed |
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
