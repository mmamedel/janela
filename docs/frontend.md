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
a `number`, and that `— çãé 🚀` survived intact. All fifteen cells pass.

Sizes are of the whole shipped artifact — the stripped executable, the summed
`.app` bundle, the `.apk` as shipped — measured from a pristine `janela init`,
not from an e2e fixture. The tables are **generated**:

```bash
node scripts/measure-sizes.mjs --measure                   # this host's desktop column
node scripts/measure-sizes.mjs --measure --target ios      # needs Xcode
node scripts/measure-sizes.mjs --measure --target android  # needs the SDK/NDK and a JDK
node scripts/measure-sizes.mjs --check                     # fail if any published figure drifted
```

Measuring a mobile column needs the toolchain but **not a device**: the builds
are offline, so only the e2e lanes need a booted simulator or emulator. Note
that Homebrew's `openjdk` is keg-only — absent from `/usr/bin`, from
`/Library/Java/JavaVirtualMachines` and from `java_home` — so a JDK here is
easy to miss; the script finds it, or tells you to set `JAVA_HOME`.

`--check` also verifies the size ranges quoted in the READMEs and on the
website, and reports any column whose figures predate the current version. It
runs no builds unless asked, so it is cheap enough for CI. The record it reads
is [`sizes.json`](sizes.json), which carries the host, the janela version and
the scriptc pin behind every column — a figure cannot outlive what produced it
without saying so.

<!-- sizes:start -->
<!-- Generated by scripts/measure-sizes.mjs. Do not hand-edit: `--check` fails on drift. -->

| template | desktop (darwin-arm64) | Android `.apk` | iOS `.app` |
|---|---|---|---|
| solid | 191 KB | 329 KB | 211 KB |
| svelte | 223 KB | 337 KB | 244 KB |
| vanilla | 225 KB | 325 KB | 228 KB |
| vue | 256 KB | 349 KB | 276 KB |
| react | 385 KB | 385 KB | 405 KB |

Sizes are rounded KiB of the shipped artifact. Raw bytes:

| template | desktop (darwin-arm64) | Android `.apk` | Android `.so` | iOS `.app` | iOS binary |
|---|---|---|---|---|---|
| solid | 195,768 | 336,395 | 854,224 | 216,449 | 215,640 |
| svelte | 228,808 | 344,587 | 882,432 | 249,493 | 248,680 |
| vanilla | 230,608 | 332,299 | 852,768 | 233,041 | 232,224 |
| vue | 261,832 | 356,875 | 908,864 | 282,505 | 281,704 |
| react | 393,944 | 393,739 | 1,038,496 | 414,625 | 413,816 |

Where each column comes from:

- **desktop (darwin-arm64)** — janela 0.14.1, scriptc 0.0.36, measured 2026-09-03 on darwin-arm64.
- **Android `.apk`** — janela 0.14.1, scriptc 0.0.36, measured 2026-09-03 on Android arm64-v8a, build-tools 36.0.0, built on darwin-arm64.
- **iOS `.app`** — janela 0.14.1, scriptc 0.0.36, measured 2026-09-03 on iOS 26.5 simulator SDK, built on darwin-arm64.

<!-- sizes:end -->

Raw byte counts are only comparable when the project name is the same length:
the name is embedded in the binary, so a two-character name builds 16 bytes
smaller than a sixteen-character one. The script always scaffolds as
`size-<template>`, which is why `--check --measure` reproduces the record
exactly; your own app will land a few bytes either side. Rounded KiB is
unaffected.

### What tree-shaking did to every column

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

The before/after tables in this section were measured under the project names
those runs happened to use, while the generated table above always scaffolds as
`size-<template>`. That is why figures here sit a few bytes off the ones above
— `vanilla` reads 230,600 here and 230,608 there, and the mobile columns differ
by 12 to 32 B the same way. It is the name-length effect, not a change in any
binary: comparisons *within* a table are exact, comparisons *across* them are
good to a few bytes.

**Mobile did not move on the bump alone** — iOS grew by 64 B and the Android
APK by one 4 KB alignment block — because the elimination is section-based
dead-stripping applied at scriptc's own *executable* link step, and iOS and
Android are the only lanes that build in library mode. There scriptc emits a
static archive and the final link is janela's. Its note beside the flag matrix
is explicit: "`--lib` preserves its established object and archive contract;
section GC is an executable-link optimization only."

So janela does that link's stripping itself, as of 0.14.1. The two lanes need
different flags. On iOS, `ld64` dead-strips per symbol subsection, so
`-Wl,-dead_strip` needs no help from `-ffunction-sections`. On Android a shared
library exports every default-visibility symbol, which roots the whole archive
and leaves `--gc-sections` almost nothing to collect (51 KB); `--exclude-libs,ALL`
drops the archive out of the dynamic symbol table first, and then GC can discard
what the shell never reaches:

| template | iOS `.app` before | after | Android `.so` before | after |
|---|---|---|---|---|
| solid | 393,513 | 216,437 | 1,407,912 | 854,208 |
| svelte | 426,541 | 249,481 | 1,436,104 | 882,416 |
| vanilla | 410,049 | 233,021 | 1,406,536 | 852,768 |
| vue | 459,553 | 282,493 | 1,462,536 | 908,832 |
| react | 591,673 | 414,613 | 1,592,184 | 1,038,480 |

The saving is **flat across templates** — 177,024–177,072 B off the iOS binary
and 553,688–553,768 B off the `.so`, so a spread of 48 and 80 bytes over a
five-template range that itself spans 200 KB. It is not literally one constant
(section padding shifts by a few bytes), but it is independent of the frontend,
which is what it should be: the dead weight is the same unreachable runtime in
every build, not anything template-specific. Runtime symbols in the iOS binary fall 807 → 227 and
Android's dynamic exports 2,751 → 154. The `scr_path_win32_*` / `scr_exec_*`
symbols that the desktop link had already dropped are now gone from both mobile
lanes too. See [`shims-to-retire.md`](shims-to-retire.md).

One saving is still upstream's: scriptc compiles the archive without
`-ffunction-sections -fdata-sections`, so on ELF the GC works at
whole-translation-unit granularity. Adding them would take the Android `.so`
from 852,720 to 674,616 — another **178 KB** — and costs nothing for anyone who
does not pass `--gc-sections`: same size, same section count, same `.text` size
and the same 2,751-symbol export set, differing only in the order of functions
within `.text`.

A note on the table's history. The desktop column replaces figures that were
correct when written — the previous 470 / 519 / 648 / 487 / 454 KB row
reproduces our 0.0.35 baseline exactly. The mobile columns were stale twice
over: 0.13.x added native file dialogs and `os_log`, which grew the iOS shell
by ~16 KB and the APK by ~8 KB against a table last measured at 0.12.0, and
then 0.14.1 stripped both lanes.

Two things worth noticing. **`solid` is smaller than `vanilla`** — not because
Solid is free, but because the `vanilla` template ships a larger hand-written
`index.html` (it demonstrates dialogs, file reading and window control inline)
while Solid's flattened bundle is ~11 KB. And **the APK spread is much
narrower** than the desktop spread — 325–385 KB against 191–385 KB — because an
APK is dominated by the shared `.so` (853 KB–1.04 MB uncompressed) rather than
by the frontend. Stripping the `.so` narrowed the APK range further, from 56 KB
to 61 KB in absolute terms but from 12% to 18% of the smallest APK, so the
frontend is now a slightly larger share of what ships.

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
