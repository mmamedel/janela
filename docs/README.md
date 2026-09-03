# janela docs

Design notes and per-platform detail. The user-facing guide is
[`packages/janela/README.md`](../packages/janela/README.md) — start there if you
just want to build something. These pages are the *why*, and the measurements
behind the claims.

## Building apps

| Page | What's in it |
|---|---|
| [`contract.md`](contract.md) | The typed IPC contract: declaring commands and events once in the host, importing the type into the page, and what the compiler checks. Also the shapes that don't compile, and why. |
| [`frontend.md`](frontend.md) | Plain HTML vs a Vite frontend, how the CLI tells them apart, how a production bundle is flattened into the binary, which Vite shapes are out of scope, and the verified template × platform matrix with sizes. |
| [`async.md`](async.md) | `commandAsync`, `sleep` and `defer`: what the platform actually allows, why the shell owns the clock, and why `await` in host code does not work. |
| [`native-shell.md`](native-shell.md) | File dialogs, runtime window control, and the Windows GUI-subsystem story. |
| [`distribution.md`](distribution.md) | Icons for every target, a macOS `.dmg`, Android release signing, and exactly what needs an Apple or Google account before you can ship. |

## Platforms

| Page | What's in it |
|---|---|
| [`ios.md`](ios.md) | Building for the iOS simulator, what differs from desktop, where files live, and the UIKit webview backend. |
| [`android.md`](android.md) | Building an APK, the toolchain you need, and why an APK carries a little Java that no other platform needs. |
| [`windows-notes.md`](windows-notes.md) | What the Windows lane required, including the two upstream landmines found along the way. |

## Testing

| Page | What's in it |
|---|---|
| [`testing.md`](testing.md) | The end-to-end suite: what a lane is, how to run desktop, the iOS simulator and an Android emulator, every `JANELA_TEST_*` knob, and why the suite never treats a zero exit code as a pass. |
| [`testing-types.md`](testing-types.md) | The two suites in `packages/janela/test/`: the compile-fail fixtures that assert the typed contract rejects the wrong shapes with the right diagnostic, and the CLI unit tests. |

## Under the hood

| Page | What's in it |
|---|---|
| [`findings.md`](findings.md) | The original proof-of-concept notes: how a TypeScript program drives a C library at all, and the compiler limits that shaped the design. Layout references predate the current package structure. |
| [`shims-to-retire.md`](shims-to-retire.md) | Every workaround janela carries for an upstream gap, tied to the issue that would let us delete it. Kept honest on purpose: debt written down as debt gets paid. |

## A note on the numbers

Sizes, timings and stall measurements in these pages are measured, not
estimated, and each page says on what. When a figure moves because a platform
or a compiler version changed, the page should be re-measured rather than
adjusted by hand — several of these numbers exist specifically because an
assumption turned out to be wrong.
