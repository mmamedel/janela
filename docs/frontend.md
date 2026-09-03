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

## What "Vite" means here

Any Vite build that produces a **single-page `dist`** — one HTML entry, one
module graph. That covers the five templates below and the ordinary
`create-vite` shapes.

Out of scope, because the output is flattened into one document:

- **multi-page / multi-entry builds** (`build.rollupOptions.input` with more
  than one HTML entry) — only the entry the CLI inlines will ship;
- **SSR and static-site generators** (Astro, SvelteKit's adapters, Nuxt) — they
  expect a server or a directory of routed HTML files;
- **frameworks with their own non-Vite build** (Angular CLI, for example)
  unless you drive them through Vite yourself.

We test five templates, not "any framework". If your build emits one HTML file
with its assets, it will very likely work; if it emits a routed tree, it will
not.

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

## Verified, and how big

Every cell below was scaffolded, built and **run**, with a probe asserting that
the framework rendered host data into the DOM, that a typed round trip returned
a `number`, and that `— çãé 🚀` survived intact. Re-measured 2026-09-03 at
janela 0.13.1 on **scriptc 0.0.36**, on an Apple Silicon Mac, an iPhone 17 Pro
simulator (iOS 26.5) and a `Medium_Phone_API_36` emulator (API 36,
WebView 133).

| template | desktop binary | iOS `.app` | Android `.apk` |
|---|---|---|---|
| solid | 191 KB | 384 KB | 473 KB |
| svelte | 223 KB | 417 KB | 480 KB |
| vanilla | 225 KB | 400 KB | 473 KB |
| vue | 256 KB | 449 KB | 493 KB |
| react | 385 KB | 578 KB | 529 KB |

All fifteen cells pass. Sizes are `KiB` of the whole artifact — the stripped
executable, the summed `.app` bundle, the `.apk` as shipped. Raw byte counts:

| template | desktop | iOS `.app` | iOS binary | Android `.apk` | Android `.so` |
|---|---|---|---|---|---|
| solid | 195,768 | 393,513 | 392,712 | 483,851 | 1,407,912 |
| svelte | 228,808 | 426,541 | 425,736 | 492,043 | 1,436,104 |
| vanilla | 230,600 | 410,049 | 409,240 | 483,851 | 1,406,536 |
| vue | 261,832 | 459,553 | 458,760 | 504,331 | 1,462,536 |
| react | 393,944 | 591,673 | 590,872 | 541,195 | 1,592,184 |

### What scriptc 0.0.36 did to the desktop column

0.0.36 shipped per-program stdlib tree-shaking
([#256](https://github.com/vercel-labs/scriptc/issues/256), their PR #271).
Both sides below are our own measurements of the same five scaffolded projects,
rebuilt across the pin bump and nothing else:

| template | 0.0.35 | 0.0.36 | change |
|---|---|---|---|
| solid | 465,272 | 195,768 | **−58%** |
| svelte | 498,296 | 228,808 | **−54%** |
| vanilla | 481,832 | 230,600 | **−52%** |
| vue | 531,320 | 261,832 | **−51%** |
| react | 663,416 | 393,944 | **−41%** |

**Mobile did not move.** iOS grew by 64 B and the Android APK by one 4 KB
alignment block. The elimination is section-based dead-stripping applied at
scriptc's own *executable* link step; iOS and Android are the only lanes that
build in library mode, where scriptc emits a static archive and Xcode or Gradle
does the final link. Measured: the desktop executable carries **0** dead
`scr_path_win32_*` / `scr_exec_*` symbols, the iOS archive still carries **11**.
See [`shims-to-retire.md`](shims-to-retire.md).

Two notes on the table's history. The desktop column above replaces figures
that were correct when written — the previous 470 / 519 / 648 / 487 / 454 KB
row reproduces our 0.0.35 baseline exactly. The **mobile** columns were already
stale before this bump: 0.13.x added native file dialogs and `os_log`, which
grew the iOS shell by ~16 KB and the APK by ~8 KB, and the table had not been
re-measured since 0.12.0.

Two things worth noticing. **`solid` is smaller than `vanilla`** — not because
Solid is free, but because the `vanilla` template ships a larger hand-written
`index.html` (it demonstrates dialogs, file reading and window control inline)
while Solid's flattened bundle is ~11 KB. And **the APK spread is much
narrower** than the desktop spread — 473–529 KB against 191–385 KB — because an
APK is dominated by the shared `.so` (~1.41–1.59 MB uncompressed) rather than
by the frontend. Tree-shaking widened that gap: `solid` and `vanilla` now ship
byte-identical APKs (483,851) despite `.so` files 1,376 B apart, because zip
alignment absorbs the difference.

The frontend is embedded as a string, so its bundle size lands in the binary
roughly 1:1 — though small additions can be free, since macOS arm64 segments
are 16 KB-aligned and a small bundle fits in existing padding.

## The browser floor

Vite's default `build.target` resolves to
`["es2020","edge88","firefox78","chrome87","safari14"]` (Vite 6.4), so app code
is transpiled down to roughly late-2020 engines. janela's injected bootstrap —
the `window.janela` shim, which Vite never sees — is deliberately **ES5**
(`var`, `function`, no arrow functions). Nothing in janela itself raises the
floor.

That matters most on Android, where the System WebView version is the device's,
not yours: a three-to-four-year-old phone typically carries WebView in the
Chrome 100–120 range, comfortably above the target. We do not pin
`build.target` in the templates, because Vite's default is already more
conservative than any WebView you are likely to meet, and lowering it further
would only bloat the output.

The residual risk is **runtime APIs, not syntax** — `structuredClone`,
`Array.prototype.at` and friends are not polyfilled by a `target` setting. If
you support old devices, check your dependencies' API use, not just their
syntax level.

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
