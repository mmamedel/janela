# janela

> *janela* — Portuguese for **window**.

Desktop and mobile apps in pure TypeScript, compiled to native. No Rust, no
Node, no Electron. The backend is TypeScript compiled to a native binary by
[scriptc](https://scriptc.dev); the window is the OS webview via
[webview/webview](https://github.com/webview/webview). Binaries come out
around 400–500 KB, with no bundled browser and no bundled runtime.

Five targets, one runtime — the same `main.ts`, the same typed contract and the
same frontend build for each:

| Platform | Webview | Build | Output |
|---|---|---|---|
| macOS | WKWebView | `janela build` | binary + `.app` |
| Linux | WebKitGTK | `janela build` | binary |
| Windows | WebView2 | `janela build` | `.exe` (GUI subsystem) |
| iOS | UIKit + WKWebView | `janela build --target ios` | simulator `.app` |
| Android | `android.webkit.WebView` | `janela build --target android` | `.apk` |

Commands, the typed contract, events, async commands and file I/O behave the
same on all five. Native file dialogs and runtime window control are
desktop-only for now; on mobile they report clearly when called.

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

Requirements: Node 24+ and a C++ toolchain for the platform you are building —
Xcode CLT on macOS; `g++` + `libwebkit2gtk-4.1-dev` on Linux; an llvm-mingw
clang on Windows (see [Windows](#windows) below). iOS additionally needs Xcode
and `zig`; Android needs a JDK, the Android SDK, the NDK and `zig`. A worked
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

Backend API (`src-host/main.ts`) — also typed, from the same package:

```ts
import type { JanelaApp } from "janela/host";

export function setup(app: JanelaApp): void {
  app.command("add", (args) => {              // values in, values out
    const a = args as { a: number; b: number };
    app.emit("added", a.a + a.b);             // push an event to the page
    return a.a + a.b;
  });
  // app.quit() closes the window and returns from run()
}
```

## The typed contract

The API above works, but `invoke<number>("add", …)` is an *assertion*: nothing
checks that the command exists, that the arguments match, or that the result
is really a number. Rename a command and the page still compiles.

Declare a contract instead, and both sides are checked against the same
declarations — no code generation, nothing to keep in sync. This is the
framework templates' default.

```ts
// src-host/main.ts
import type { JanelaApp } from "janela/host";

export type AppCommands = {
  add:   (args: { a: number; b: number }) => number;
  greet: (args: { name: string }) => string;
  wait:  (args: { ms: number }) => string;
  quit:  () => void;                        // a command that takes nothing
};
export type AppEvents = { added: number };

/** The app, carrying its contract. This is what the page imports. */
export type App = JanelaApp<AppCommands, AppEvents>;

// Typing the app with the contract is what makes the methods below checked.
export function setup(app: App): void {
  app.command("add", (args) => {            // args inferred: { a: number; b: number }
    app.emit("added", args.a + args.b);     // event name and payload checked
    return args.a + args.b;                 // return type checked against the contract
  });
  app.commandAsync("wait", (args, resolve) => {
    app.sleep(args.ms, () => resolve("waited " + args.ms + "ms"));
  });
}
```

```ts
// src/App.tsx (or .vue, .svelte …)
import { createClient } from "janela/api";
import type { App } from "../src-host/main";   // type-only: erased at compile time

const client = createClient<App>();

const sum = await client.invoke("add", { a: 2, b: 40 });  // sum: number
const off = client.on("added", (v) => console.log(v));    // v: number
off();                                                     // unsubscribe
```

Now these are all compile errors:

```ts
await client.invoke("addd", { a: 1, b: 2 });   // unknown command
await client.invoke("add", { a: 1, b: "2" });  // wrong argument type
const s: string = await client.invoke("add", { a: 1, b: 2 });  // wrong result
client.on("addedd", () => {});                 // unknown event
client.on("added", (v: string) => {});         // wrong payload type
```

Two things worth knowing:

- **`import type` is erased**, so no host code is bundled into the page — the
  contract is a type edge and nothing more. (Verified: the built frontend
  bundle contains none of the host's strings.)
- **Types erase at runtime.** Payloads still cross as JSON and nothing
  validates a malformed one. This is compile-time safety, like Tauri's
  `invoke<T>()` — the difference is that here the types come from the host's
  own declarations rather than from an assertion you write by hand, which is
  only possible because both sides are TypeScript.

A command that takes nothing is declared `() => void`, and its handler
returns `null` — every command answers the page's promise with a value, so
`void` is normalised to `null`. The page calls it as
`client.invoke("quit", null)`.

An **event payload is a single value** of any JSON-shaped type. For an event
carrying several things, prefer an object (`{ done: number; total: number }`):
adding a field later does not break existing listeners, and the names read
better at the call site. A tuple works too, but note that only the payload
*value* may be a tuple — the varargs spelling `app.emit("progress", 3, 10)`
does not compile (`SC2011: values of type '[done: number, total: number]'
have no static representation`, which would require `--dynamic` and ~620 KB
of embedded engine).

The `{ args; result }` record form of 0.5.x–0.7.x is still accepted, and the
untyped `invoke` / `listen` still work unchanged; the contract is additive,
and the `vanilla` template still uses the global.

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
(they all run after it closes). janela schedules through the shell instead: the
runtime parks a continuation under an id, the shell keeps the clock and calls
it back on the UI thread when it comes due. Nothing polls, so an idle app
costs nothing at all.

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

## Migrating from 0.7.x

Commands are declared as the functions they are. The old `{ args; result }`
record form still compiles, so this is optional — but the function form is
shorter, and a command that takes nothing is finally natural to write.

```ts
// 0.7.x
export type AppCommands = {
  add:  { args: { a: number; b: number }; result: number };
  quit: { args: null; result: null };
};

// 0.8.0
export type AppCommands = {
  add:  (args: { a: number; b: number }) => number;
  quit: () => void;
};
```

Nothing else changes: `export type App = JanelaApp<AppCommands, AppEvents>`,
`setup(app: App)`, `app.command(...)` and the page's `createClient<App>()` are
all as they were. A handler for a `() => void` command returns `null`.

## Migrating from 0.6.x

The contract lives entirely in the types now, so the runtime tokens are gone.
Name the app instead of wrapping its two tables:

```ts
// before (0.6.x)
import { defineCommands, defineEvents, type JanelaApp } from "janela/host";

export const commands = defineCommands<AppCommands>();
export const events = defineEvents<AppEvents>();
export type App = { commands: typeof commands; events: typeof events };

export function setup(app: JanelaApp<AppCommands, AppEvents>): void { … }

// after (0.7.x)
import type { JanelaApp } from "janela/host";

export type App = JanelaApp<AppCommands, AppEvents>;

export function setup(app: App): void { … }
```

`AppCommands` and `AppEvents` are unchanged, and so is every page: the
frontend still writes `createClient<App>()` and `client.invoke(...)`, because
`createClient` reads the contract off either shape.

`defineCommands` and `defineEvents` still exist and still work — they are
`@deprecated` no-ops that only ever carried types — so a 0.6.x project keeps
compiling and running untouched.

## Migrating from 0.5.x

The contract now rides on the app itself, so the standalone registrars are no
longer needed. Type the app with your contract and call its methods:

```ts
// before (0.5.x)
export function setup(app: JanelaApp): void {
  on(app, commands, "add", (args) => args.a + args.b);
  onAsync(app, commands, "wait", (args, resolve) => { … });
  emit(app, events, "added", 42);
}

// after (0.6.x)
export function setup(app: JanelaApp<AppCommands, AppEvents>): void {
  app.command("add", (args) => args.a + args.b);
  app.commandAsync("wait", (args, resolve) => { … });
  app.emit("added", 42);
}
```

Declare each contract as a named type and hand both to the app (0.7.x drops
the `defineCommands` / `defineEvents` tokens entirely — see above):

```ts
export type AppCommands = { add: { args: { a: number; b: number }; result: number } };
export type AppEvents = { added: number };
export type App = JanelaApp<AppCommands, AppEvents>;
```

`on`, `onAsync` and `emit` still work — they are `@deprecated` one-line
wrappers now — so 0.5.x code keeps compiling. The page side is unchanged:
`createClient<App>()` and `client.invoke(...)` are exactly as before. An app
with no contract needs no change at all: `setup(app: JanelaApp)` still gets an
untyped `app.command(name, handler)`.

## Migrating from 0.4.x

Nothing breaks: `app.command`, `app.emit`, and the untyped `invoke` / `listen`
all work exactly as before, and the `vanilla` template is unchanged.

Two things are new:

- `listen()` (and the injected `janela.listen`) now **return a disposer**.
  Previously they returned nothing, so existing code is unaffected.
- The **typed contract** — a contract-typed app on the host,
  `createClient<App>()` on the page. The framework templates now scaffold with
  it. See [The typed contract](#the-typed-contract). (0.4.x shipped this with
  `defineCommands` / `defineEvents` tokens; 0.7.x replaced them with the `App`
  type alias below, and the tokens are deprecated but still work.)

To adopt it in an existing app, declare what the host already exposes and swap
the registrations:

```ts
// before
app.command("add", (args) => {
  const a = args as { a: number; b: number };
  return a.a + a.b;
});

// after
export type AppCommands = {
  add: { args: { a: number; b: number }; result: number };
};
export type AppEvents = { added: number };
export type App = JanelaApp<AppCommands, AppEvents>;

app.command("add", (args) => args.a + args.b);   // args inferred, no cast
```

then on the page, replace `invoke<number>("add", …)` with
`client.invoke("add", …)` built from `createClient<App>()`.

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

The host side had the same problem and gets the same fix. `src-host/main.ts`
used to import `JanelaApp` from `"./janela"` — a path that only exists inside
`.janela/build/`, so an editor could never resolve it and the whole `app.*`
API was untyped:

```ts
// 0.3.x — unresolved in the editor; JanelaApp was effectively `any`
import type { JanelaApp } from "./janela";

// 0.4.x — resolves against the installed package
import type { JanelaApp } from "janela/host";
```

`janela build` rewrites that specifier to the local runtime copy while
assembling the compile unit, so the build stays fully static and a project
with no `node_modules` at all still compiles.

The framework templates (`vue`, `react`, `svelte`, `solid`) are TypeScript now
and scaffold with a `typecheck` script that covers `src/` and `src-host/`
alike. `vanilla` stays plain JavaScript on the global, so it still needs no
`npm install` before the first build.

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

## iOS

An iOS build runs the same app from the same source — same `main.ts`, same
contract, same frontend:

```bash
janela build --target ios     # -> .janela/out-ios/<name>.app  (simulator)
janela dev   --target ios     # build, boot a simulator, install, launch
```

It is **simulator-only** so far — device builds and code signing are not
wired up yet. Commands, the typed
contract, events, Vite frontends, async commands (`commandAsync`, `defer`,
`sleep`) and file I/O all work the same as on desktop — the shell owns the
clock and the file queue on both. File dialogs are not on iOS yet and report
clearly when called; window control is a no-op there by nature. See
[docs/ios.md](../../docs/ios.md).

## Android

Same again: same `main.ts`, same contract, same frontend.

```bash
janela build --target android   # -> .janela/out-android/<name>.apk
janela dev   --target android   # build, boot an emulator, install, launch, follow logcat
```

Needs a JDK, the Android SDK, the NDK and zig; there is no Gradle in the build.
Commands, events, `commandAsync`/`sleep`/`defer` and file I/O all behave as
they do on desktop and iOS — the shell owns the clock on each. Native dialogs
are not on Android yet and report clearly when called; `setTitle` sets the
Activity label and the other window controls are no-ops by nature. See
[docs/android.md](../../docs/android.md).

Unlike every other platform an APK also carries a little Java: the webview
backend needs a companion class, because `android.webkit.WebView` is a Java API
whose callbacks native code cannot receive on its own.

## Status

Young and pre-1.0. Desktop (macOS arm64, Linux/WebKitGTK, Windows/WebView2) is
the most exercised path; iOS and Android are newer, and iOS is simulator-only.
The design notes and scriptc findings behind it are in
[docs/findings.md](../../docs/findings.md), with per-platform notes in
[docs/ios.md](../../docs/ios.md) and [docs/android.md](../../docs/android.md).

Not yet: native dialogs and window control on mobile; device builds and code
signing; icons, installers and notarization; async commands that run in
parallel (host code is single-threaded, so `commandAsync` interleaves and a
CPU-bound handler still needs slicing); an async HTTP client; tray icons and
menus; multi-window; directory picking on Windows; and `app.center()`.

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
