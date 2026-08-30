# iOS

> **Status: branch only, not released.** This works end to end in the iOS
> simulator, but it is not part of a published janela version yet. Device
> builds, signing and the App Store are not covered.

A janela app builds and runs on iOS from the same source as its desktop
build — the same `src-host/main.ts`, the same typed contract, the same
frontend.

```bash
janela build --target ios     # -> .janela/out-ios/<name>.app  (simulator)
janela dev   --target ios     # build, boot a simulator, install, launch, follow the log
```

Requirements: macOS with Xcode, an iOS simulator runtime (Xcode → Settings →
Components), and **zig** (`brew install zig`) — scriptc routes mobile targets
through `zig cc`.

## Configure it

`janela.conf.json` gains an `ios` section; every field is optional and falls
back to the values already there.

```json
{
  "name": "my-app",
  "identifier": "dev.janela.my-app",
  "ios": {
    "identifier": "dev.janela.my-app",
    "displayName": "My App",
    "minimumVersion": "15.0"
  }
}
```

## How it differs from desktop

Desktop compiles your TypeScript to an **executable** that owns `main()` and
drives a C library over FFI. iOS turns that around: scriptc refuses to build
executables for iOS targets, so your TypeScript becomes a **static library**
and a UIKit shell owns `main()`, hosts the `WKWebView`, and calls in.

You do not write any of that. The CLI picks a lane by which runtime it
compiles your project against, so nothing in your app has to know which target
it is being built for — no `isIOS` branches, no alternate API.

A library build links **no event loop of its own** (scriptc rejects an async
module graph in library mode, `SC4005`) — but that is not a limitation you
meet, because janela never asks the compiled TypeScript to hold a timer on
either platform. It parks a continuation under an id and the shell owns the
clock: `dispatch_after` on the main queue here, a timer queue in the shim on
desktop. Same design, same behaviour.

## What works today

| | iOS |
|---|---|
| `app.command` + typed contract | yes |
| `app.emit` → `janela.listen` | yes |
| `janela.invoke` from the page | yes |
| Vite frontends (vue/react/svelte/solid) | yes |
| Plain `index.html` | yes |
| UTF-8 including emoji | yes |
| `app.commandAsync` | yes |
| `app.defer`, `app.sleep` | yes |
| `app.readFileAsync`, `app.writeFileAsync` | yes |

## Not yet on iOS

These exist and compile — your desktop code still builds for iOS — but each
one reports clearly when called instead of doing nothing.

| | why | reported as |
|---|---|---|
| `app.openFileDialog`, `app.saveFileDialog` | iOS wants `UIDocumentPickerViewController`, which brings its own delegate lifecycle and security-scoped URLs | through the callback's error argument |
| `app.setTitle`, `app.setSize`, `app.setFullscreen` | an iOS app has no window to title or resize — this one is permanent, not unfinished | logged, then a no-op |
| `app.quit` | iOS apps are dismissed by the user, not by code — also permanent | logged, then a no-op |

Only the dialogs are pending work; the window-control entries are meaningless
on a phone and will stay no-ops.

### File paths on iOS

A sandboxed app has no useful working directory and cannot see host paths, so
a **relative path resolves against the app's Documents directory** — the one
place it can freely read and write:

```ts
app.writeFileAsync("notes.txt", body, (err) => { … });   // Documents/notes.txt
```

An absolute path is used as given, which on a device means somewhere inside
the app container.

Also not covered yet: real devices (needs a signing identity and a
provisioning profile), the App Store, and Android (needs the NDK and a JNI
shell).

## Evidence

![async, timers and file I/O on iOS](img/ios-parity.png)

A scaffolded app in the simulator: a sync command answering at `t+0ms` while
an async one is pending, four continuations firing in due order from
registrations made out of order, a rejected command, and a file written and
read back byte-exact including `— çãé 🚀`.

![the vue template on iOS](img/ios-vue.png)

## Under the hood

- `packages/janela/runtime/ios.ts` — the iOS runtime lane. Same class name and
  public surface as the desktop runtime, so your `main.ts` compiles against
  either; a command registry and a dispatcher, with no loop machinery.
- `packages/janela/shim/ios/app.mm` — the UIKit shell: `UIWindow`, a root view
  controller, the `WKWebView`, and the script-message bridge. It injects the
  same `window.janela` bridge the desktop shim does, so `janela/api` works
  unchanged.
- One library export carries every command (`handleInvoke(cmd, args) -> string`),
  so your commands need no ABI of their own; a second returns the page. Events
  travel the other way through a declared callback channel.

The `WKWebView` and script-message-handler wiring follows the approach used by
[wry](https://github.com/tauri-apps/wry) (Apache-2.0), `src/wkwebview/`. wry
attaches its webview to a `UIView` supplied by tao; janela has no tao, so the
shell creates the window and root view controller itself.
