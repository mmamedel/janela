# janela

> *janela* — Portuguese for **window**.

Desktop apps in pure TypeScript, compiled to native. No Rust, no Node, no
Electron. The backend is TypeScript compiled to a native binary by
[scriptc](https://scriptc.dev); the window is the OS webview via
[webview/webview](https://github.com/webview/webview) (WKWebView on macOS,
WebKitGTK on Linux). Binaries come out ~500 KB.

## Quick start

```bash
npm install -g janela     # or: npx janela init my-app
janela init my-app        # (or `jn init my-app`)
cd my-app
janela dev                # build + run with logs in the terminal
janela build              # .janela/out/my-app  (+ my-app.app on macOS)
```

Requirements: Node 18+, a C++ compiler (Xcode CLT on macOS; g++ +
`libwebkit2gtk-4.1-dev` on Linux). A worked example lives in
[`examples/demo`](examples/demo) — commands, events, and a file reader.

## A project

```
my-app/
├── index.html          frontend — any HTML/JS; calls janela.invoke() / janela.listen()
├── src-host/main.ts    backend — exports setup(app), registers commands
└── janela.conf.json    name, bundle identifier, version, window
```

Frontend API (injected before page load):

```js
const sum = await janela.invoke("add", { a: 2, b: 40 }); // call a backend command
janela.listen("added", (payload) => { ... });            // backend-fired events
```

Backend API (`src-host/main.ts`):

```ts
import type { JanelaApp } from "./janela";

export function setup(app: JanelaApp): void {
  app.command("add", (argsJson) => {          // args in / result out as JSON text
    const a = JSON.parse(argsJson) as { a: number; b: number };
    app.emit("added", JSON.stringify(a.a + a.b));  // push an event to the page
    return JSON.stringify(a.a + a.b);
  });
  // app.quit() closes the window and returns from run()
}
```

## Async commands

A command that has to wait — or to chew through real work — should not freeze
the window. Register it with `commandAsync` and answer whenever you are ready;
the page keeps using the same `await janela.invoke(...)`.

```ts
app.commandAsync("wait", (argsJson, resolve, reject) => {
  const a = JSON.parse(argsJson) as { ms: number };
  app.sleep(a.ms, () => resolve(JSON.stringify("done")));   // resolve later
});

// Work that cannot just wait: slice it, yielding to the UI between slices.
app.commandAsync("countTo", (argsJson, resolve) => {
  const a = JSON.parse(argsJson) as { n: number };
  let i = 0;
  const step = (): void => {
    const end = Math.min(i + 2_000_000, a.n);
    for (; i < end; i++) { /* ... */ }
    if (i < a.n) app.defer(step); else resolve(JSON.stringify(i));
  };
  app.defer(step);
});
```

- `app.defer(fn)` — run `fn` on the next turn of the host loop.
- `app.sleep(ms, fn)` — run `fn` after at least `ms`.
- `resolve(json)` / `reject(json)` settle the page's promise; `reject` makes
  `await janela.invoke(...)` throw. Settling twice is ignored.

**Use `app.sleep`, not `setTimeout`.** scriptc's own event loop is parked for
as long as the program sits inside the `run()` FFI call, so `setTimeout`,
`queueMicrotask` and `await` in host code never fire while the window is open
(they all run after it closes). janela supplies its own loop instead: a native
ticker posts work to the UI thread via `webview_dispatch`, and it only runs
while something is queued, so an idle app costs nothing.

**Still single-threaded.** scriptc's runtime is not thread-safe (concurrent
calls from several threads abort the process), so host code always runs on the
UI thread. Async here means *interleaved*, not parallel: a handler that blocks
without yielding still freezes the window. Slice long work with `defer`.

The backend is ordinary TypeScript with scriptc's stdlib — including a
`node:fs` subset — so "read a file" or "call an API" is just code in a
command handler, no plugin layer needed.

## What the CLI hides

`janela build` assembles `.janela/build/` (runtime + your `main.ts` +
generated `frontend.ts`/`config.ts`/`entry.ts` + a platform FFI manifest),
compiles the C shim over webview.h once into `.janela/cache/`, then runs
scriptc. On macOS the frameworks are linked as SDK `.tbd` stubs (scriptc has
no `-framework` support) and the binary is wrapped into an ad-hoc-signed
`.app` bundle.

## Constraints inherited from scriptc 0.0.32

- Command args/results cross the boundary as **JSON text** — handlers
  `JSON.parse` in and `JSON.stringify` out. The runtime keeps the byte channel
  ASCII by `\uXXXX`-escaping non-ASCII (scriptc strings can't hold lone
  surrogates, and `JSON.parse` is the reliable reassembly point).
- Never use a bare FFI call as a complete variable initializer or assignment
  RHS — it is silently miscompiled. Wrap it in any expression (`+ 0`). Plain
  TypeScript is unaffected; only the runtime does FFI, so app code rarely
  meets this.
- One window per app for now. Host code is single-threaded: a synchronous
  command blocks the UI while it runs — use `commandAsync` + `defer`/`sleep`
  (see "Async commands") for anything slow.
- `console.log` from commands goes to stdout — visible under `janela dev`,
  not when launched from Finder.

## Status

Early proof of concept, macOS (arm64) and Linux (WebKitGTK). The design
notes and scriptc findings behind it are in
[docs/findings.md](docs/findings.md). Not yet: Windows, async commands
that run in parallel (host code is single-threaded; `commandAsync` interleaves
instead), native dialogs/tray/menus, multi-window,
icons/installers/notarization.

## Releasing

Bump `version` in `package.json` and merge to `main`. The publish workflow
then does the rest: it compares the version against the registry, and if it
is new, scaffolds/builds/runs a smoke app on Linux, publishes to npm with
trusted publishing (OIDC — no token secret), tags the published commit
`v<version>`, and opens a GitHub release with generated notes.

A merge that does not change the version is a clean no-op: nothing is
published and no tag is created. If a publish ever succeeds but the tagging
step does not, npm and git are briefly out of step — reconcile with:

```bash
git tag -a v<version> -m "janela <version>" <commit>
git push origin v<version>
gh release create v<version> --generate-notes --verify-tag
```

## License

MIT. Bundles [webview/webview](https://github.com/webview/webview) headers
(MIT, © Serge Zaitsev and contributors).
