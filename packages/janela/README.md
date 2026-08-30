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

Or start from a frontend framework — any Vite-based one:

```bash
janela init my-app --template vue     # or react | svelte | solid | vanilla
cd my-app && npm install
janela dev                            # Vite dev server + HMR, in a native window
```

`vanilla` is the default and needs no frontend toolchain at all. With a
framework, `janela dev` runs your Vite dev server and points the window at it,
and `janela build` flattens the production bundle into the binary — see
[docs/frontend.md](../../docs/frontend.md).

Requirements: Node 18+, a C++ compiler (Xcode CLT on macOS; g++ +
`libwebkit2gtk-4.1-dev` on Linux; see [Windows](#windows) below). A worked
example lives in [`examples/demo`](examples/demo) — commands, events, and a
file reader.

## Windows

`janela build` produces `.janela/out/<name>.exe` using the WebView2 backend.

**You need a MinGW-targeting clang on `PATH`** — [llvm-mingw][llvm-mingw],
MSYS2's `clang64` toolchain, or WinLibs. MSVC does **not** work: scriptc's
runtime uses POSIX types and calls (`ssize_t`, `nanosleep`, `clock_gettime`)
that the MSVC CRT does not provide. janela checks `clang -dumpmachine` and
tells you if the wrong one is first on `PATH`.

webview.h's Win32 backend includes `WebView2.h`, which Microsoft ships in a
nuget package rather than in the Windows SDK, so the first build downloads
`Microsoft.Web.WebView2` into `.janela/cache/` automatically. To build offline
or pin your own copy, point `JANELA_WEBVIEW2_INCLUDE` at a directory
containing `WebView2.h`. No `WebView2Loader.dll` is needed — webview.h has its
own loader — and end users need only the **WebView2 runtime**, which is
preinstalled on current Windows 10/11 (it ships with Edge).

`janela build` produces a **GUI-subsystem** `.exe`, so no console window
appears behind the UI — which also means `console.log` from a command has
nowhere to go. `janela dev` keeps the console subsystem, so logs are there
while you work. (scriptc exposes no way to pass `-mwindows` to the linker, so
janela rewrites the PE `Subsystem` field after linking; see
[docs/native-shell.md](../../docs/native-shell.md).)

One caveat today: there is no installer step — you get a bare `.exe`, not an
MSI.

[llvm-mingw]: https://github.com/mstorsjo/llvm-mingw/releases

## A project

```
my-app/
├── index.html          frontend — any HTML/JS/TS; calls invoke() / listen()
├── src-host/main.ts    backend — exports setup(app), registers commands
└── janela.conf.json    name, bundle identifier, version, window
```

A Vite project adds a `vite.config.js` and a `src/` tree — that config is what
makes janela build the frontend with Vite instead of inlining `index.html`
directly.

Frontend API — import it, and your editor and `tsc` know the shapes:

```ts
import { invoke, listen } from "janela/api";

const sum = await invoke<number>("add", { a: 2, b: 40 }); // call a backend command
listen<number>("added", (payload) => { ... });            // backend-fired events
```

`janela` is already a devDependency of a scaffolded project, so there is
nothing extra to install. The generic is what the host command returns —
values cross the boundary as values, so there is no JSON to parse.

<details>
<summary>No bundler? Use the injected global instead</summary>

janela injects the same two functions as `window.janela` before every document
loads, which is what the `vanilla` template uses — it needs no `npm install` at
all:

```js
const sum = await janela.invoke("add", { a: 2, b: 40 });
janela.listen("added", (payload) => { ... });
```

TypeScript users on this path can pull in the ambient types with
`/// <reference types="janela/global" />`, or by adding `"janela/global"` to
`compilerOptions.types`. With a bundler, prefer the import — it needs no
ambient declaration.

</details>

Backend API (`src-host/main.ts`):

```ts
import type { JanelaApp } from "./janela";

export function setup(app: JanelaApp): void {
  app.command("add", (args) => {              // values in, values out
    const a = args as { a: number; b: number };
    app.emit("added", a.a + a.b);             // push an event to the page
    return a.a + a.b;
  });
  // app.quit() closes the window and returns from run()
}
```

## Async commands

A command that has to wait — or to chew through real work — should not freeze
the window. Register it with `commandAsync` and answer whenever you are ready;
the page keeps using the same `await janela.invoke(...)`.

```ts
app.commandAsync("wait", (args, resolve, reject) => {
  const a = args as { ms: number };
  app.sleep(a.ms, () => resolve("done"));   // resolve later
});

// Work that cannot just wait: slice it, yielding to the UI between slices.
app.commandAsync("countTo", (args, resolve) => {
  const a = args as { n: number };
  let i = 0;
  const step = (): void => {
    const end = Math.min(i + 2_000_000, a.n);
    for (; i < end; i++) { /* ... */ }
    if (i < a.n) app.defer(step); else resolve(i);
  };
  app.defer(step);
});
```

- `app.defer(fn)` — run `fn` on the next turn of the host loop.
- `app.sleep(ms, fn)` — run `fn` after at least `ms`.
- `resolve(value)` / `reject(reason)` settle the page's promise; `reject`
  makes `await janela.invoke(...)` throw. Settling twice is ignored.

## File I/O

`node:fs` works in a handler, but `readFileSync` **blocks the window** for as
long as the syscall runs — parking a promise does not change that. Use the
async pair instead: the syscall runs on a worker thread inside the shim, and
only the result crosses back to your (single-threaded) TypeScript.

```ts
app.commandAsync("readFile", (args, resolve) => {
  const a = args as { path: string };
  app.readFileAsync(a.path, (err, text) => {
    if (err !== null) { resolve({ ok: false, error: err }); return; }
    resolve({ ok: true, text });
  });
});

app.writeFileAsync("out.txt", "contents", (err) => { /* err is null on success */ });
```

Errors arrive as values, never throws — `err` carries a Node-shaped message
(`ENOENT: no such file or directory, open '/x'`). UTF-8 round-trips exactly,
astral characters included.

The payload crosses in a single call (format 3), and the decode that follows is
spread across turns under a 4 ms budget, so a large read no longer stalls the
window: a 100 MB file's worst UI pause is ~25 ms (p99 4 ms) rather than ~176 ms,
at the same throughput. The remaining pause is the one unavoidable copy that
materialises the string for your callback. See
[docs/async.md](../../docs/async.md) for the measurements — and note that
indexing a large string in your own callback (`text.length`, `slice`) is O(n)
in scriptc and can cost far more than the read did.

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

## Native dialogs and window control

```ts
app.commandAsync("openFile", (_args, resolve) => {
  app.openFileDialog(
    { title: "Pick a file", filters: [{ name: "Text", extensions: ["txt", "md"] }] },
    (paths, err) => {
      if (paths === null) { resolve({ cancelled: true }); return; }   // cancel
      app.readFileAsync(paths[0], (rerr, text) => resolve({ path: paths[0], text }));
    },
  );
});

app.saveFileDialog({ defaultName: "untitled.txt" }, (path) => { /* … */ });

app.setTitle("new title");
app.setSize(720, 480, 0);
app.setFullscreen(true);
```

A cancel is `null`, not an error. Options: `title`, `defaultPath`, `filters`,
plus `multiple` and `directory` for open, and `defaultName` for save.
`directory: true` is not supported on Windows and reports `ENOTSUP`.

Use `commandAsync` for dialogs — the user may take as long as they like, and
the window keeps serving other calls meanwhile. The modal itself runs on a
later UI-thread turn rather than inside the call that requests it, because a
nested modal loop would otherwise re-enter the host loop underneath a live TS
frame; [docs/native-shell.md](../../docs/native-shell.md) has the details, the
per-platform table, and the Windows GUI-subsystem note.

## Migrating from 0.3.x

Nothing breaks: the injected `janela` global still works exactly as before.
What changed is the recommendation — the frontend now has a real module, so
editors and `tsc` can see it:

```ts
// 0.3.x — an untyped global, invisible to tsc and ESLint
const sum = await janela.invoke("add", { a: 2, b: 40 });

// 0.4.x — typed, resolvable, and generic over what the command returns
import { invoke } from "janela/api";
const sum = await invoke<number>("add", { a: 2, b: 40 });
```

The framework templates (`vue`, `react`, `svelte`, `solid`) are TypeScript now
and scaffold with a `typecheck` script. `vanilla` stays plain JavaScript on the
global, so it still needs no `npm install` before the first build.

## Migrating from 0.1.x

Commands used to take and return **JSON text**; they now take and return
**values**, with the runtime handling serialisation. The page-side API
(`invoke` / `listen`) is unchanged.

```ts
// 0.1.x
app.command("add", (argsJson) => {
  const a = JSON.parse(argsJson) as { a: number; b: number };
  app.emit("added", JSON.stringify(a.a + a.b));
  return JSON.stringify(a.a + a.b);
});

// 0.2.x
app.command("add", (args) => {
  const a = args as { a: number; b: number };
  app.emit("added", a.a + a.b);
  return a.a + a.b;
});
```

Mechanically: drop the `JSON.parse(argsJson)` (cast `args` instead), drop
every `JSON.stringify` around a result, `resolve`/`reject`/`emit` payload, and
return nothing at all where you used to return `"null"`. Requires Node 24 to
build (scriptc 0.0.35's floor).

## What the CLI hides

`janela build` assembles `.janela/build/` (runtime + your `main.ts` +
generated `frontend.ts`/`config.ts`/`entry.ts` + a platform FFI manifest),
compiles the C shim over webview.h once into `.janela/cache/`, then runs
scriptc. On macOS the frameworks are linked as SDK `.tbd` stubs (scriptc has
no `-framework` support) and the binary is wrapped into an ad-hoc-signed
`.app` bundle.

## Constraints inherited from scriptc

- Command args and results are ordinary values; the runtime serialises them at
  the boundary, so anything that survives `JSON.stringify`/`JSON.parse` round
  trips (including full Unicode). `args` is typed `unknown` — cast it to the
  shape you expect.
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

Early proof of concept, on macOS (arm64), Linux (WebKitGTK) and Windows
(WebView2). The design notes and scriptc findings behind it are in
[docs/findings.md](../../docs/findings.md). Not yet: async commands that run in
parallel (host code is single-threaded; `commandAsync` interleaves instead),
tray icons and menus, multi-window, directory picking on Windows,
`app.center()`, and icons/installers/notarization.

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
