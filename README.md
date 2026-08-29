# janela — monorepo

> Desktop apps in pure TypeScript, compiled to native. No Rust, no Node, no Electron.
> **[janela.dev docs → mmamedel.github.io/janela](https://mmamedel.github.io/janela/)** ·
> **[npm](https://www.npmjs.com/package/janela)**

This is the workspace. The framework itself, its README, and its docs live in
[`packages/janela`](packages/janela).

| Path | What it is | Published? |
|---|---|---|
| [`packages/janela`](packages/janela) | the framework: CLI, TypeScript runtime, C shim over webview.h, project templates | yes — [`janela`](https://www.npmjs.com/package/janela) on npm |
| [`examples/demo`](examples/demo) | a worked app: commands, events, async, a file reader | no |
| [`website`](website) | the landing page, deployed to GitHub Pages | no |
| [`docs`](docs) | design notes: scriptc findings, the async model, the Windows port | no |

## Working in the repo

```bash
corepack enable          # pnpm comes from packageManager in package.json
pnpm install

pnpm dev                 # build + run examples/demo with logs in the terminal
pnpm build:demo          # just build it
pnpm janela init my-app  # scaffold a new app anywhere
```

Requirements: Node 18+ and a C++ compiler — Xcode Command Line Tools on macOS,
`g++` + `libwebkit2gtk-4.1-dev` on Linux, and an **llvm-mingw** clang on
Windows (MSVC cannot build scriptc's runtime; see
[`docs/windows-notes.md`](docs/windows-notes.md)).

## Releasing

Bump `version` in `packages/janela/package.json` and merge to `main`. CI
smoke-builds and runs a scaffolded app on Linux, macOS, and Windows; the
publish workflow then publishes to npm via trusted publishing (OIDC, no
token), tags the published commit `v<version>`, and creates the GitHub
release. A merge that doesn't change the version is a clean no-op.

MIT. Bundles [webview/webview](https://github.com/webview/webview) headers
(MIT, © Serge Zaitsev and contributors); compiles with
[scriptc](https://scriptc.dev) (Apache-2.0).
