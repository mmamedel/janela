# Async commands: what the platform actually allows

Measured against scriptc 0.0.32 + webview.h, 2026-08-29; the design still
holds on 0.0.36 (re-checked 2026-09-03 — library mode still refuses `async`
and microtasks still do not drain across host re-entries, so the shell still
owns the clock). FFI format 5 was evaluated on the same 0.0.36 pin and
rejected, 2026-09-18 — see "Why not FFI format 5" below. Every claim here was
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

## Why not FFI format 5

scriptc 0.0.36 added a fifth FFI format whose one new capability is
`invoke: "foreign"`: a callback that may be called from any native thread
without the generator inserting a dispatch hop. It is gated to callbacks that
are `retained`, return `void`, and carry a `context` entry
(`ffi-manifest.js:189-202`, mirrored at `validate.js:1163-1174`) — of janela's
four callbacks, only `wvOnTimer`'s qualifies; `wvOnInvoke` and `wvOnMenu`
return `i32`, and `wvJobTakeAt`'s is `lifetime: "call"`.

That still does not help here, because of how a foreign call is delivered. The
generated trampoline stages the args and calls `scr_ffi_post()`
(`scr_ffi_queue.c:237-255`), which appends to a process-global list and writes
one byte to a wake pipe — nothing more. The list is drained only from
*scriptc's own* event loop, via the hook `scr_ffi_install()` wires up
(`scr_ffi_queue.c:314-329` → `scr_ffi_dispatch()` at `scr_async.c:2316`),
inside the same `while` that owns the loop's sleep (`scr_async.c:2416-2459`).
janela's loop is parked inside the blocking `wv_run()` for the app's entire
life; it has not started when the window opens and does not turn again until
`wv_run` returns. So a foreign-posted timer id would be delivered only after
the window has closed — the one moment `wv_run` deliberately forbids delivery
(it nulls the handlers on the way out precisely so nothing calls into TS once
`run()` has returned). This is the same failure the author reported upstream
in scriptc#260 after probing a blocking FFI call.

It also cannot be registered safely for the app's lifetime: `scr_ffi_pending()`
reports pending while any foreign registration exists at all, not just while
calls are queued (`scr_ffi_queue.c:270-276`), and that value gates the loop's
own exit check (`scr_async.c:2408-2416`). Teardown only runs from
`scr_atexit(scr_ffi_teardown_all)` (`scr_ffi.c:22`) — after the loop, too late
to release the hold. A retained `wvOnTimer` under format 5 would therefore
plausibly keep the process from exiting once the window closes.

`webview_dispatch` is the pump here, not a format-4 workaround: it runs on the
*platform* loop `wv_run` is spinning, which is the only loop turning while the
window is open. Format 5 would swap a turning loop for a parked one. So
`ffi_format` stays 4, and janela declares no `invoke: "foreign"` callback
(machine-checked in `packages/janela/test/unit/lib.test.mjs`).

## The design

Cooperative async on the UI thread, pumped from native code:

1. `wv_defer(h)` — called from inside a bind callback, moves the invoke's call
   id into a pending table and tells the trampoline *not* to call
   `webview_return`. The page's promise stays unsettled.
2. `wv_resolve(h, id, status)` — answers that call later with whatever the
   runtime has staged in the reply buffer.
3. `wv_schedule(h, id, ms)` — the runtime parks a continuation under `id` and
   asks the shell to call it back in `ms`. The shell keeps a due-ordered timer
   queue and one thread that only sleeps and calls `webview_dispatch`, so the
   continuation runs **on the UI thread**. The thread never touches TS itself,
   so the SIGABRT hazard above is avoided. A zero delay skips the queue and
   posts straight to the next turn, which is all `app.defer()` needs.

**The shell owns the clock; TS owns the id.** Nothing polls: an idle app has an
empty queue and its scheduler thread blocks on a condition variable rather than
waking periodically. A finished file read or dismissed dialog announces itself
with the reserved `TIMER_JOBS` id instead of being noticed by a tick.

This is deliberately the same shape a library-mode host (iOS) must use, where
the compiled TypeScript links no event loop at all and *cannot* hold a timer —
so one design serves both platforms rather than each growing its own.

Everything reaches TS through `webview_dispatch`, i.e. at the top of a later
turn with no TS frame beneath it. That rule is kept by construction because a
breach is invisible: a host that re-enters from inside a callback gets
correct-looking results right up until it doesn't (reported upstream as
vercel-labs/scriptc#263).

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
a pool and marshal results back through `webview_dispatch`. A second, separate
upstream change would lift the loop-parking problem above: a pump entry point
(`run_once()` / `poll()`, scriptc#260) that lets a host give the script loop a
turn from inside its own blocking call, instead of only between calls.

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
app.commandAsync("readFile", (args, resolve) => {
  const a = args as { path: string };
  app.readFileAsync(a.path, (err, text) => {
    resolve(err !== null ? { ok: false, error: err } : { ok: true, text });
  });
});
```

Verified: a `ping` command answered at **t+0 ms** while a 1 MB read was still
in flight, and the read completed at t+129 ms. Quitting with two reads in
flight exits 0 — the shim joins its workers at shutdown.

### The cost is the drain, not the read

The syscall runs on a worker thread, so it never touches the window. What does
cost UI-thread time is the **drain**: turning the job's UTF-8 bytes into a
TypeScript string, which is proportional to the payload.

Taken in one call, that cost lands in a single turn — a 100 MB file froze the
window for ~176 ms. So the drain is **time-budgeted** instead: each turn takes
128 KB slices until `DRAIN_BUDGET_MS` (4 ms) is spent, then yields to the run
loop and continues with a zero-delay continuation — the same mechanism as
`app.defer()`. The budget is wall-clock rather than a fixed chunk count on
purpose: a fixed chunk size bounds the worst turn but also caps throughput,
whereas a time budget spends whatever the machine manages in the time
available. Because the continuation is posted rather than waiting for a tick,
yielding costs only a dispatch round trip.

Measured on macOS arm64 (M-series, warm page cache), reading files that carry
multi-byte characters throughout. "Max stall" is the worst round-trip of a
`ping` command hammered from the page while the read is in flight — i.e. what
the window actually feels:

| File | Max stall before | Max stall now | Read time before | Read time now |
|---|---|---|---|---|
| 1 MB | 11 ms | 10 ms | 11 ms | 11 ms |
| 10 MB | 29 ms | 9 ms | 48 ms | 58 ms |
| 100 MB | **176 ms** | **25 ms** | 453 ms | 467 ms |

p99 round-trip during a 100 MB read is 4 ms. Throughput is within ~3% of the
old all-at-once path.

The residual ~25 ms at 100 MB is the final `parts.join("")`: the callback
receives one string, so the whole payload must be materialised once, and that
copy cannot be split across turns. Removing even that would mean handing the
app its bytes in chunks rather than as one value — a streaming read API, which
janela does not have today.

**Slices never split a character.** `wv_job_take_at` pulls the slice end back
to a UTF-8 sequence boundary before handing it to TS, because scriptc decodes
a `string` param as UTF-8 and a mid-sequence cut would produce replacement
characters on both sides of the seam. Bytes that are not valid UTF-8 have no
boundary to find, so after four steps the cut stands as asked. Verified with
100 MB of text carrying `— çãé 🚀` every ~1 KB: 103,207 astral characters
survive a 800-slice drain exactly.

**Two traps found while measuring this**, both worth knowing when writing host
code that touches large strings:

- Building a string with `s = s + c` in a loop is O(n²) in scriptc — 200k
  single-character appends cost 449 ms versus **2 ms** for `parts.push(c)` +
  `join("")`. Anything in this runtime that accumulates a string must use
  push + join.
- **Indexing a large string is O(n).** scriptc stores strings as UTF-8 but
  exposes UTF-16 indices, so it must scan to convert between them:
  `text.slice(text.length - 12)` on a 104 MB string costs **74 ms**, and
  `text.length` alone costs 6 ms. That is *your* cost, not the drain's — a
  callback that probes a huge string will stall the window no matter how
  carefully the runtime delivered it.
