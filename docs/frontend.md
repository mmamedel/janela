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
idiom: calling a host command (`invoke`), receiving a host event (`listen`),
and an async command that doesn't freeze the window.

```bash
cd my-app
npm install     # not needed for vanilla
janela dev
```

## The frontend API

Two ways in, for two kinds of project.

**With a bundler — import it.** This is what the framework templates use:

```ts
import { invoke, listen } from "janela/api";

const sum = await invoke<number>("add", { a: 2, b: 40 });
listen<number>("added", (payload) => console.log(payload));
```

`janela/api` is a subpath of the `janela` package, which is already a
devDependency of a scaffolded project — there is nothing extra to install. It
is a few lines of ESM wrapping the injected bridge, so it adds no measurable
weight to a bundle, and it ships hand-written declarations: the generic is what
the host command returns, and the payload type flows into a listener callback.

**Without one — use the global.** janela injects `window.janela` before every
document loads, so a plain `<script>` needs no build step at all. That is what
the `vanilla` template does, and why it needs no `npm install`:

```js
const sum = await janela.invoke("add", { a: 2, b: 40 });
janela.listen("added", (payload) => console.log(payload));
```

TypeScript users on the global can pull in ambient types with
`/// <reference types="janela/global" />`, or by adding `"janela/global"` to
`compilerOptions.types` in tsconfig.json.

Both routes reach the same bridge — the import is a wrapper over the global,
not a second transport. Importing is the recommendation because a bundler can
resolve it, an editor can complete it, and `tsc` and ESLint can see it; a bare
global is invisible to all three.

If the page is opened outside a janela window — in a browser, or under a plain
`vite dev` you started yourself — the wrapper throws a message saying exactly
that, rather than `undefined is not an object`.

## TypeScript

The framework templates are TypeScript and scaffold a `typecheck` script:

```bash
npm run typecheck     # vue-tsc / tsc / svelte-check, per template
```

`vanilla` stays plain JavaScript so that it keeps working with no toolchain.

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

Measured on macOS arm64, stripped, for the scaffolded templates (vanilla and vue
re-measured at 0.11.0; the rest are from the same run that established the shape):

| template | binary |
|---|---|
| vanilla | ~470 KB |
| solid | ~470 KB |
| svelte | ~502 KB |
| vue | ~519 KB |
| react | ~648 KB |

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
