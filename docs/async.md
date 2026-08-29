# Async commands: what the platform actually allows

Measured against scriptc 0.0.32 + webview.h, 2026-08-29. Every claim here was
verified with a probe binary, not inferred from documentation.

## The blocking finding

scriptc has a real event loop — `setTimeout`, `queueMicrotask`, promises and
`async`/`await` all work in a compiled binary. **But that loop does not run
while the program is inside an FFI call**, and janela sits inside one
(`wv_run`) for the entire life of the window.

A probe scheduled `setTimeout(..., 10)`, then entered a 300 ms blocking FFI
call, then a second FFI call that re-entered TS three times:

```
[ts] entering blocking FFI for 300ms; timer was due at 10ms
[ts] back from block, timerFired = false
[ts]   in callback 0 timerFired = false      <- re-entrant TS, loop still parked
...
[ts] fakeRun returned 0 timerFired = false
[ts] microtask (before FFI block)            <- everything drains only at exit
[ts] TIMER FIRED
```

So host-side `await` is a trap: it compiles, and it never resumes until the
app closes. janela must supply its own loop.

## Why not threads

Calling compiled TS from one non-main thread happens to work. Calling it from
four at once does not:

```
$ scriptc run p3.ts --ffi p3.ffi.json     # 4 threads x 2000 calls into TS
scriptc: program killed by SIGABRT
```

scriptc's runtime (refcounting, allocator) has no thread safety. Combined with
the webview's own UI-thread affinity, this settles the architecture: **host
code only ever runs on the UI thread.** Worker-thread TS is off the table
until scriptc says otherwise.

## The design

Cooperative async on the UI thread, pumped from native code:

1. `wv_defer(h)` — called from inside a bind callback, moves the invoke's call
   id into a pending table and tells the trampoline *not* to call
   `webview_return`. The page's promise stays unsettled.
2. `wv_resolve(h, id, status)` — answers that call later with whatever the
   runtime has staged in the reply buffer.
3. `wv_tick_start(h, ms)` / `wv_tick_stop(h)` — a C++ thread that only sleeps
   and calls `webview_dispatch`, which runs the tick **on the UI thread**,
   where it re-enters TS to drain the runtime's task and timer queues. The
   thread never touches TS itself, so the SIGABRT hazard above is avoided.

The ticker runs only while the runtime has queued work, so an idle app does no
periodic wakeups. Because the pump is native rather than page-driven
(`setInterval` + invoke would also work), pending work still progresses when
the page is idle and awaiting.

## What this buys, and what it does not

Verified ordering with a 400 ms async command in flight:

```
[host] slow: started, parking the promise
[host] ping: answered WHILE slow was pending
[host] page: ping returned pong at t+116ms
[host] page: chunked returned {"slices":20,"acc":true} at t+335ms
[host] slow: timer elapsed -> resolving
[host] page: slow returned 'slow done after 400ms' at t+419ms
```

- Waiting is free: `app.sleep` costs no UI responsiveness.
- CPU work is interleavable, but only if the author slices it with
  `app.defer`. A tight loop inside one handler still freezes the window —
  there is no preemption.
- No parallelism. Two CPU-bound commands do not use two cores.

The upstream change that would lift this: thread-safe scriptc runtime objects
(or a documented per-thread runtime), which would let the shim run handlers on
a pool and marshal results back through `webview_dispatch`.
