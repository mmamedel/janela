> Historical design notes from the original PoC (repo layout references
> predate the janela package structure). The scriptc findings and the
> shim design rationale still apply.

# scriptc + webview.h PoC — findings

Answering the open question: **can scriptc hand a native library a function
pointer, so a JS frontend can call back into TypeScript?**

**Yes.** Verified end-to-end against a real WebKitGTK window. But the released
compiler is more restrictive than the published docs, and the shape of the
shim is dictated by those restrictions.

Environment: `scriptc` 0.0.35 (npm, published 2026-08-22), `webview/webview`
@ `cbbdee4`, Ubuntu 24.04, WebKitGTK 4.1, clang 18, headless via Xvfb.

## What works

| Capability | Result |
|---|---|
| Pass a TS closure as a C function pointer | ✅ `ffi_format: 2`, `lifetime: "call"` |
| Callback invoked repeatedly from a C loop | ✅ fires N times, order preserved |
| Callback closes over TS state and mutates it | ✅ counters, arrays, strings |
| **Re-entrant FFI from inside a callback** | ✅ **the key enabler** |
| Multiple distinct callback-taking functions | ✅ distinct `id`s in one manifest |
| Blocking run-loop that dispatches while blocked | ✅ exactly `webview_run`'s shape |

The re-entrancy result is what makes the whole design viable: while C is
inside the TS callback, TS can call *back* into C. That is how the request
payload gets across a boundary that only passes scalars.

## Hard limits in 0.0.35 (docs describe formats 1–5; only 1–2 are implemented)

From `dist/ffi/profile.d.ts`:

- Callback params: **numeric only** — `f64 bool u8 u32 i32`. No `string`,
  no `bytes`. So `webview_bind`'s `(const char *id, const char *req, void *)`
  **cannot be bound directly.**
- `lifetime: "call"` only. No `"retained"` — `webview_bind` wants to *store*
  the callback, which is not expressible.
- Return types: `f64 bool u8 u32 i32 void`. **No pointer/u64 type**, so
  `webview_t` from `webview_create()` can never cross the boundary.
- No `cstring`; strings arrive as `(const uint8_t *, size_t)`, **not
  NUL-terminated** — the shim must copy before calling any C string API.

The published guide at scriptc.dev/ffi documents `"lifetime": "retained"`
(format 4+), `cstring`, string/bytes callback params, and `"invoke":
"foreign"`. **None of those exist in the shipped compiler.** Don't design
against the docs.

## Compiler bug found

A bare FFI call used as a *complete* variable initializer or assignment RHS is
silently miscompiled — no diagnostic, and at runtime you get
`ReferenceError: <fn> is not defined`. The emitted C shows
`scr_undef_global_read("nativeScale")` instead of the call.

```ts
const r = nativeScale(21);        // ✗ silently broken
let r = 0; r = nativeScale(21);   // ✗ silently broken
function f(){ const r = nativeScale(21); return r; }  // ✗ silently broken

console.log(nativeScale(21));     // ✓
const r = nativeScale(21) + 0;    // ✓ any enclosing expression fixes it
return nativeScale(21);           // ✓
const a = [nativeScale(21)];      // ✓
nativeScale(21);                  // ✓ statement position
```

This affects *all* FFI functions, not just callback-taking ones. It bites
immediately because the docs' own worked example only happens to work by being
inline. Worth filing upstream. Workaround used throughout `app/app.ts`: `+ 0`.

## The design that works

Three constraints → three workarounds:

1. **No pointer type** → handle table in the shim; `wv_create()` returns an
   `i32` index, never a `webview_t`.
2. **No retained callbacks** → don't give the callback to `webview_bind`.
   Give it to `wv_run()`, which blocks for the entire life of the app. The
   shim registers its *own* static C trampoline with `webview_bind`, and that
   trampoline calls the TS callback. `lifetime: "call"` and "app lifetime"
   become the same thing.
3. **Scalar-only callback args** → the trampoline stages the request JSON in a
   shim-side buffer and passes TS only `(bindIndex, seq)`. TS drains the
   payload with re-entrant `wvReqByte(h, i)` calls and pushes the response
   back with `wvReplyPush`. The shim then calls `webview_return`.

Byte-at-a-time marshalling is O(n) FFI calls per message. Fine at PoC scale;
if a `bytes` *out*-param or a string return type ever lands, that's the one
piece to replace.

## Proof

`app/app.ts` (TypeScript, no Rust anywhere) creates the window, binds three
functions, and serves them. The frontend does:

```js
const sum = await window.hostAdd(2, 40);
await window.hostLog('js saw sum=' + sum);
await window.hostQuit(0);
```

Output:

```
[ts] created webview handle 0
[ts] bound hostAdd/hostLog/hostQuit -> 0 1 2
[ts] dispatch bind=0 seq=1 req=[2,40]
[ts] dispatch bind=1 seq=2 req=["js saw sum=42"]
[ts] js says: js saw sum=42
[ts] dispatch bind=2 seq=3 req=[0]
[ts] quit requested after 3 calls
[ts] run returned 0 — handled 3 IPC calls
```

`window.png` shows the rendered window displaying `hostAdd(2,40) -> 42` — a
value computed in the native TS binary and returned into the DOM.

Binary: **526 KB**, no Node, no V8, no QuickJS linked (`--dynamic` not used).
The only JS engine present is JavaScriptCore *inside the webview*, which is
the frontend's engine — same as Tauri.

## Verdict

The architecture is sound and the blocking unknown is resolved. What you give
up versus Tauri is that the IPC bridge needs ~200 lines of C shim rather than
being free, and you must avoid the initializer bug until it's fixed.

Not yet addressed: Windows, multi-threaded `webview_dispatch` from a non-UI
thread, and packaging/signing.

## macOS (2026-08-29)

Ported and verified on macOS 26 / arm64 (Apple Silicon), WKWebView backend.
Same three IPC round trips, exit 0, binary 491 KB. Two porting facts:

- The Cocoa backend of `webview.h` is written against the raw ObjC runtime
  API, so the shim compiles as plain C++ — no `-x objective-c++`, no
  Objective-C in the build.
- scriptc's manifest still has no `-framework` support, but `libraries`
  entries are handed to the link as plain input files and **ld64 accepts
  `.tbd` framework stubs** — `build.sh` generates `app/app.ffi.gen.json`
  on Darwin with the SDK's `WebKit.tbd` + `Cocoa.tbd` paths and
  `system_libraries: ["c++"]` (Apple has no `libstdc++`).

`run.sh` (Xvfb) is Linux-only; on macOS just run `./app/wvapp`.

## janela (2026-08-29): the Tauri-shaped toolkit (né wvkit)

The PoC is now factored into **`janela/`** (the tauri-crate + tauri-cli
analogue: shim, vendored webview, runtime library, `janela init|dev|build` CLI, `jn` alias)
and **`demo/`** (a project holding only `index.html`, `src-host/main.ts`,
`janela.conf.json`). One `__invoke` binding carries every command as a
`(name, argsJson)` envelope; `wv_init` (new shim fn) injects the
`janela.invoke`/`janela.listen` bootstrap; `wv_eval` backs `app.emit` events.
See `janela/README.md`. The original flat `app/` + `build.sh` remain as the
minimal reference and are superseded by janela for actual work.

New scriptc findings from this round:

- **Strings are UTF-16 in API but UTF-8 in storage**: `"🚀".length === 2`
  and `charCodeAt` yields surrogate halves, but
  `fromCharCode(0xd83d) + fromCharCode(0xde80)` does NOT reassemble — each
  lone surrogate becomes U+FFFD. `JSON.parse("\"\\ud83d\\ude80\"")` DOES
  reassemble. So byte-level channels must ship non-ASCII as JSON `\uXXXX`
  escapes and let `JSON.parse` rebuild it (janela's runtime does this both
  directions; the original `app.ts` marshalling is ASCII-only and silently
  corrupts non-ASCII — the shim masks pushed bytes with `& 0xff`).
- Multi-file relative imports, `import type`, interfaces, closures stored in
  arrays/objects, and self-referential objects with closure methods all
  compile fine — enough for a real library surface.

## Layout

```
janela/           the framework: bin/janela.mjs CLI, runtime/janela.ts,
                  shim/wvshim.cc (+wv_init), vendor-webview/, templates/
demo/             a janela project: index.html + src-host/main.ts + janela.conf.json
                  (builds land in demo/.janela/out/)
--- original flat PoC, kept as the minimal reference ---
build.sh          compile shim + TS binary
run.sh            run headless under Xvfb
shim/wvshim.cc    C-ABI shim over webview.h (handle table, trampoline, marshalling)
app/app.ts        the app, in TypeScript
app/app.ffi.json  FFI manifest
exp/              the isolation tests behind every claim above
window.png        screenshot of the running window
```
