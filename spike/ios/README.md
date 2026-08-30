# SPIKE — janela on iOS

Throwaway evidence, not shipped code. Nothing here is wired into the package.

The question: janela's desktop model has TypeScript owning `main` and calling a
blocking `wv_run()`. iOS inverts that — UIKit owns the run loop and calls you.
Does the inverted shape (native shell + TypeScript as a scriptc **library**)
work on iOS?

## Layout

    lib.ts        the TypeScript side: one export, `handleInvoke(cmd, args) -> string`
    profile.json  the scriptc library profile (ABI symbols + declared exports)
    app.mm        the UIKit shell: UIWindow, WKWebView, script-message bridge
    build.sh      the whole recipe, host TS -> iOS .app
    hostcheck/    the same lib.ts driven from a C main on the host, as a control

## Build

    ./build.sh          # -> build/Janela.app (arm64, platform 7 = iOS Simulator)

Requires zig (scriptc routes mobile targets through `zig cc`) and the iOS SDK.

## Attribution

The WKWebView / WKUserContentController / script-message-handler wiring follows
the approach used by [wry](https://github.com/tauri-apps/wry) (Apache-2.0,
© Tauri Programme within The Commons Conservancy), `src/wkwebview/`. wry attaches
its webview to a UIView supplied by tao; this spike creates the UIWindow and
UIViewController itself. The IPC envelope is janela's own.
