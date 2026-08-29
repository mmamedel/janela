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

## Non-blocking file I/O

Parking a promise does not make a blocking syscall stop blocking. `readFileSync`
inside a `commandAsync` handler still freezes the window for the duration of
the read — the loop cannot turn while the host is inside the syscall, exactly
as it cannot turn while it is inside `wv_run`.

Node solves this with libuv's thread pool; janela solves it the same way, in
the shim:

- `wv_fs_read` / `wv_fs_write` start a `std::thread` that performs the syscall
  into a job buffer and flips an atomic status. The worker touches only its own
  job and **never calls into TS** — scriptc's runtime is not thread-safe, so
  that invariant is what keeps this sound.
- The host loop polls finished jobs on its tick and drains the bytes on the UI
  thread, where TS is safe to run.
- On failure the job buffer holds the error message instead of the contents, so
  success and failure share one drain path. Errors surface as values
  (`ENOENT: no such file or directory, open '/x'`), never as throws.

```ts
app.commandAsync("readFile", (argsJson, resolve) => {
  const a = JSON.parse(argsJson) as { path: string };
  app.readFileAsync(a.path, (err, text) => {
    resolve(JSON.stringify(err !== null ? { ok: false, error: err } : { ok: true, text }));
  });
});
```

Verified: a `ping` command answered at **t+0 ms** while a 1 MB read was still
in flight, and the read completed at t+129 ms. Quitting with two reads in
flight exits 0 — the shim joins its workers at shutdown.

### The cost is the drain, not the read

Format-2 FFI has no `bytes` return, so the payload crosses one byte per call
and is rebuilt in TS. Measured on macOS arm64 (M-series, warm page cache):

| File | Total |
|---|---|
| 1 MB | 120 ms |
| 10 MB | 1,170 ms |

That is ~8.5 MB/s, and it is spent **on the UI thread**, inside one tick. So
the syscall no longer blocks the window, but materializing a very large file
still does, for roughly 115 ms per MB. Read config files and documents freely;
do not stream video through it.

**A quadratic trap found while measuring this.** Building the result with
`s = s + c` in a loop is O(n²) in scriptc 0.0.32 — 200k single-character
appends cost 449 ms versus **2 ms** for `parts.push(c)` + `join("")`. That one
change took a 1 MB read from 11,888 ms to 120 ms (99×). `drainJob` and
`readRequest` both build with push+join for this reason; anything in this
runtime that accumulates a string in a loop must do the same.

The pending upgrade to scriptc 0.0.35 (FFI formats 3–5: `bytes` params,
`cstring`, retained callbacks) should remove the byte-at-a-time drain
altogether, which is why no packing micro-optimisation was attempted here.
