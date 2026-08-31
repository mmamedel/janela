# janela — monorepo

> Desktop and mobile apps in pure TypeScript, compiled to native. No Rust, no Node, no Electron.
> macOS · Linux · Windows · iOS · Android — one runtime, ~400–500 KB binaries.
> **[janela.dev docs → mmamedel.github.io/janela](https://mmamedel.github.io/janela/)** ·
> **[npm](https://www.npmjs.com/package/janela)**

This is the workspace. The framework itself, its README, and its docs live in
[`packages/janela`](packages/janela).

| Path | What it is | Published? |
|---|---|---|
| [`packages/janela`](packages/janela) | the framework: CLI, TypeScript runtime, C shim over webview.h, project templates | yes — [`janela`](https://www.npmjs.com/package/janela) on npm |
| [`examples/demo`](examples/demo) | a worked app: commands, events, async, a file reader | no |
| [`website`](website) | the landing page, deployed to GitHub Pages | no |
| [`docs`](docs) | design notes: the typed contract, the async model, the iOS and Android ports, scriptc findings | no |

## Working in the repo

```bash
corepack enable          # pnpm comes from packageManager in package.json
pnpm install

pnpm dev                 # build + run examples/demo with logs in the terminal
pnpm build:demo          # just build it
pnpm janela init my-app  # scaffold a new app anywhere
```

Requirements: Node 24+ and a C++ toolchain for the platform you are building —
Xcode Command Line Tools on macOS, `g++` + `libwebkit2gtk-4.1-dev` on Linux,
and an **llvm-mingw** clang on Windows (MSVC cannot build scriptc's runtime; see
[`docs/windows-notes.md`](docs/windows-notes.md)). Mobile builds need more:
Xcode and `zig` for iOS ([`docs/ios.md`](docs/ios.md)), and a JDK, the Android
SDK, the NDK and `zig` for Android ([`docs/android.md`](docs/android.md)).

Packaging for other people — icons, a macOS `.dmg`, Android release signing, and
what needs an Apple or Google account — is in
[`docs/distribution.md`](docs/distribution.md).

All five frontend templates (`vanilla`, `vue`, `react`, `svelte`, `solid`) are
built and run on desktop, the iOS simulator and an Android emulator; the matrix
and sizes are in [`docs/frontend.md`](docs/frontend.md).

```bash
pnpm janela init my-app --template vue   # vanilla | vue | react | svelte | solid
cd my-app && npm install
janela dev                               # desktop, with Vite HMR
janela dev --target ios                  # simulator: build, boot, install, launch
janela dev --target android              # emulator: same, plus logcat
```

## Releasing

Bump `version` in `packages/janela/package.json` and merge to `main`. CI
smoke-builds and runs a scaffolded app on Linux, macOS, and Windows; the
publish workflow then publishes to npm via trusted publishing (OIDC, no
token), tags the published commit `v<version>`, and creates the GitHub
release. A merge that doesn't change the version is a clean no-op.

MIT. Bundles [webview/webview](https://github.com/webview/webview) headers
(MIT, © Serge Zaitsev and contributors); compiles with
[scriptc](https://scriptc.dev) (Apache-2.0).
