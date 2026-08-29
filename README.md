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
`libwebkit2gtk-4.1-dev` on Linux; see [Windows](#windows) below). A worked
example lives in [`examples/demo`](examples/demo) — commands, events, and a
file reader.

## Windows

`janela build` produces `.janela/out/<name>.exe` using the WebView2 backend.
You need **clang** (LLVM, which targets the installed MSVC toolchain) and
**Visual Studio Build Tools**; `clang` must be on `PATH`.

webview.h's Win32 backend includes `WebView2.h`, which Microsoft ships in a
nuget package rather than in the Windows SDK, so the first build downloads
`Microsoft.Web.WebView2` into `.janela/cache/` automatically. To build offline
or pin your own copy, point `JANELA_WEBVIEW2_INCLUDE` at a directory
containing `WebView2.h`.

End users of your app need the **WebView2 runtime**, which is preinstalled on
current Windows 10/11 (it ships with Edge).

Two Windows caveats today: the binary is a console subsystem app, so a console
window appears behind the UI (fine for `janela dev`, not for shipping), and
there is no installer/packaging step — you get a bare `.exe`, not an MSI.

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
- One window per app for now; the run loop is single-threaded, so a slow
  command blocks the UI (same as a blocking Tauri command handler).
- `console.log` from commands goes to stdout — visible under `janela dev`,
  not when launched from Finder.

## Status

Early proof of concept, macOS (arm64) and Linux (WebKitGTK). The design
notes and scriptc findings behind it are in
[docs/findings.md](docs/findings.md). Not yet: Windows, async commands
(the run loop is single-threaded), native dialogs/tray/menus, multi-window,
icons/installers/notarization.

## License

MIT. Bundles [webview/webview](https://github.com/webview/webview) headers
(MIT, © Serge Zaitsev and contributors).
