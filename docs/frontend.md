# Frontends: plain HTML or Vite

janela apps come in two shapes, and the CLI picks between them by looking for a
Vite config at the project root (`vite.config.js|ts|mjs|mts|cjs|cts`).

| | plain | Vite |
|---|---|---|
| detected by | no vite config | a vite config at the project root |
| `janela build` | inlines `index.html` verbatim | runs `vite build`, then flattens `dist/` into one document |
| `janela dev` | builds and runs | starts the Vite dev server, points the window at it (HMR) |
| dependencies | none | whatever your framework needs |

Plain projects are unchanged from earlier janela versions — no toolchain, no
`npm install` before the first build.

## Why one document

The shim hands the webview a single HTML string (`webview_set_html`); there is
no file server behind the window and no `file://` root. So a production build
is *flattened*: the module script is inlined, the stylesheet becomes a
`<style>`, and every other asset that lives in `dist/` (images, fonts, favicons,
`url()` references inside CSS) is rewritten as a `data:` URI.

Two alternatives were considered and rejected for now:

- **Embed `dist/` and serve it from a localhost HTTP server in the shim.** Opens
  a port on the user's machine, and needs a C++ HTTP server in the shim.
- **Register a custom URI scheme** (`WKURLSchemeHandler` on macOS,
  `webkit_web_context_register_uri_scheme` on Linux, `WebResourceRequested` on
  Windows). The cleanest long-term answer, but it is three platform-specific
  implementations.

Flattening costs neither, and an app only outgrows it when a single document
becomes unwieldy — many megabytes of assets, or code-splitting you actually want
at runtime.

## Templates

```bash
janela init my-app                      # vanilla (default, no dependencies)
janela init my-app --template vue
janela init my-app --template react
janela init my-app --template svelte
janela init my-app --template solid
```

Every framework template demonstrates the same three things in that framework's
idiom: calling a host command (`janela.invoke`), receiving a host event
(`janela.listen`), and an async command that doesn't freeze the window.

```bash
cd my-app
npm install     # not needed for vanilla
janela dev
```

## What `janela dev` does

1. Picks a free port and starts your project's Vite dev server on it
   (`vite --port <n> --strictPort`).
2. Waits for it to answer.
3. Builds the native host binary, whose embedded document is a one-line stub:
   `location.replace("http://localhost:<n>/")`.
4. Runs it, and stops Vite when the window closes.

`window.janela` is injected per-document by the shim (`webview_init`), so it
exists on the Vite-served page exactly as it does on an inlined one.

**Frontend edits hot-reload. Host edits do not** — `src-host/main.ts` is
compiled into the binary, so changing it means re-running `janela dev`.

## Size

Measured on macOS arm64, stripped, for the scaffolded templates:

| template | binary |
|---|---|
| vanilla | 448 KB |
| solid | 448 KB |
| svelte | 481 KB |
| vue | 514 KB |
| react | 646 KB |

The frontend is embedded as a string, so its bundle size lands in the binary
roughly 1:1 — though small additions can be free, since macOS arm64 segments
are 16 KB-aligned and a small bundle fits in existing padding (Solid's 11 KB
costs 8 bytes).

## Limits worth knowing

- **One document.** No runtime code-splitting, no dynamic `import()` of a
  separate chunk, no web workers loaded from a URL. Vite inlines dynamic imports
  into the single bundle when it can; anything it emits as a separate chunk that
  the HTML does not reference will not be inlined.
- **`public/` files** are copied to `dist/` but only inlined if something in the
  HTML or CSS references them.
- **Source maps** are not inlined (they would double the binary). Debug through
  `janela dev`, where Vite serves real sources.
- **The origin is `null`** in a built app (the document comes from a string, not
  a URL). Anything requiring a real origin — service workers, some storage APIs,
  cookies — will not work in a build, though it does under `janela dev`, where
  the page is served from `http://localhost`. Prefer host commands for
  persistence: `app.readFileAsync` / `app.writeFileAsync`.
- **`node_modules` is a dev-time cost only** — nothing from it ships except the
  bundled output.
