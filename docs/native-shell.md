# Native shell: dialogs, window control, the macOS menu, Windows subsystem

## File dialogs

```ts
app.openFileDialog(
  {
    title: "Pick a file",
    defaultPath: "/tmp",
    multiple: false,
    directory: false,
    filters: [{ name: "Text", extensions: ["txt", "md"] }],
  },
  (paths, err) => {
    // paths: string[] on confirm, null on cancel. err is set only when the
    // platform refused outright.
  },
);

app.saveFileDialog(
  { title: "Save as", defaultName: "untitled.txt" },
  (path, err) => { /* path: string | null */ },
);
```

A cancel is **not** an error: `paths`/`path` is `null` and `err` is `undefined`.
`err` carries a message only for a platform-level refusal, such as asking for
`directory: true` on Windows.

Pair a dialog with `commandAsync`, not `command`: the user may take as long as
they like, and an async command parks the page's promise instead of holding the
reply open.

```ts
app.commandAsync("openFile", (_args, resolve) => {
  app.openFileDialog({}, (paths) => {
    if (paths === null) return resolve({ cancelled: true });
    app.readFileAsync(paths[0], (err, text) => resolve({ path: paths[0], text }));
  });
});
```

### Why the dialog does not run inside the call that asks for it

`runModal` (macOS) and `gtk_dialog_run` (Linux) spin a **nested event loop**.
If they ran directly inside the invoke handler, that nested loop would pump the
shim's ticker and re-enter the host loop's `turn()` underneath a TS frame that
is still live — draining task, timer and job queues that the outer frame is in
the middle of using.

So `wv_dialog()` does not open anything. It allocates a job, posts the modal
with `webview_dispatch`, and returns an id immediately. The panel opens at the
top of a later UI-thread turn, with no TS beneath it, and the answer is drained
by the same polling loop that serves file I/O. Dialogs and file reads are both
"work whose answer cannot be produced during the FFI call that asks for it",
which is why they share one job pool in the shim.

### Per-platform notes

| | macOS | Linux | Windows |
|---|---|---|---|
| open / save | NSOpenPanel / NSSavePanel | GtkFileChooserDialog | GetOpenFileNameW / GetSaveFileNameW |
| filters | `setAllowedFileTypes:` | `GtkFileFilter` | filter pairs |
| multi-select | yes | yes | yes |
| `directory: true` | yes | yes | **no** — returns `ENOTSUP` |

Windows uses the `comdlg32` entry points rather than `IFileDialog`. On Vista
and later they render the modern common item dialog anyway, with none of the
COM ceremony — but they cannot pick directories, which is the one gap above.

## Window control

```ts
app.setTitle("new title");
app.setSize(720, 480, 0);   // hint: 0 none, 1 min, 2 max, 3 fixed
app.setFullscreen(true);
```

All three are callable at any time, including from inside a command handler
(which already runs on the UI thread). `setFullscreen` is
`toggleFullScreen:` on macOS (guarded by reading `styleMask`, since the Cocoa
call only toggles), `gtk_window_fullscreen`/`unfullscreen` on Linux, and the
save-placement / strip-`WS_OVERLAPPEDWINDOW` / fill-monitor dance on Windows.

`app.center()` is not implemented.

## macOS: the main menu

Every janela app installs a standard macOS main menu. There is no API for it
and nothing to call — it is set up in the shim right after the webview exists,
and it is a no-op on Windows and Linux.

It is there because **on macOS a Command-key shortcut is a menu key
equivalent, not a window-manager gesture.** With no main menu nothing claims
⌘Q, ⌘C, ⌘V, ⌘X, ⌘Z or ⌘A, and the app silently ignores all of them — an app
window with a text input where paste does nothing. Alt+F4 on Windows is
unaffected by any of this: it is a `WM_CLOSE` the win32 backend already
answers, and the editing keys are handled inside WebView2 and WebKitGTK. So
this is a macOS-only fix, not a cross-platform feature.

| submenu | items |
|---|---|
| *app name* | About · Hide (⌘H) · Hide Others (⌥⌘H) · Show All · **Quit (⌘Q)** |
| Edit | Undo (⌘Z) · Redo (⇧⌘Z) · Cut (⌘X) · Copy (⌘C) · Paste (⌘V) · Select All (⌘A) |
| View | Enter Full Screen (⌃⌘F) |
| Window | Minimize (⌘M) · Close (⌘W) |

Every item is a **standard AppKit selector** travelling up the responder
chain, so there are no custom actions and nothing calls back into TypeScript.
WKWebView answers the editing ones itself. AppKit also adds its own standard
extras to correctly-named menus, which is why the Edit menu gains Writing
Tools and Emoji & Symbols, and Window gains the window list, without us asking.

**Quit is wired to `performClose:`, not `terminate:`.** Both quit and both exit
0, but `terminate:` exits the process itself, so the host never returns from
`wv_run` and anything after `app.run()` is skipped. `performClose:` goes
through the same path the window's red button uses, so the run loop unwinds and
the host finishes normally — one shutdown path instead of two. Tauri's `muda`
picks `terminate:` because its app logic is native and multi-window; janela is
single-window, so closing the window *is* quitting. If janela grows multiple
windows, this has to become a real Quit that closes all of them.

Costs 208 bytes.

### Custom menus

Your own submenus go in with `app.setMenu`, and clicks arrive on `app.onMenu`:

```ts
import { menuItem, menuSeparator, submenu } from "janela/host";

app.setMenu([
  submenu("File", [
    menuItem("Open…", "open", "CmdOrCtrl+O"),
    menuSeparator(),
    submenu("Recent", [menuItem("Clear", "clear", "")]),
  ]),
]);

app.onMenu((id) => {
  if (id === "open") { /* … */ }
});
```

**They are added to the standard menus, not swapped for them.** Replacing the
bar wholesale is what would cost the app ⌘Q and ⌘V, so `setMenu` appends and a
later call replaces only what an earlier one added — the menu can shrink as
well as grow. `setMenu` returns `false` where custom menus are not supported
yet (everything but macOS) and the standard menu is left alone either way.

Modifiers in `accel`: `Cmd`, `Ctrl`, `CmdOrCtrl`, `Alt`/`Option`, `Shift`. Pass
`""` for no shortcut. The mask is always set explicitly, including empty,
because AppKit's default for a key equivalent is Command — so an accelerator
with no modifiers would silently become a Command shortcut.

#### Why it is shaped this way

Not like Tauri's `muda`, which is a builder API in native code — that fits
Tauri because its app logic is native too. janela's app logic is TypeScript, so
the tree is declared there and the native side only renders it: the runtime
flattens the entries into one row per line with `0x1f` between fields, and the
shim splits on those. **Nothing native parses JSON, and no new concepts were
added** — clicks come back on a retained callback with the same shape as
`on_invoke`.

`MenuEntry` is a *total* record, built by the three helpers rather than written
as a literal. That is a scriptc constraint turned into a nicer API: a record
whose fields are all optional infers as `{ label: string | undefined, … }`, and
an array mixing a submenu, an item and a separator becomes a union scriptc
refuses to re-tag (`SC2003: union types must match exactly`). The helpers each
return the same shape, so the array is homogeneous and the call site still
reads as a tree.

#### What it costs

Nothing at all unless you call it. A scaffolded app that never mentions
`setMenu` is **byte-identical** with the feature added — 195,792 both sides —
because scriptc tree-shakes the unused runtime and the linker dead-strips the
shim's menu code. Adding the two calls above costs **16,800 bytes**
(195,784 → 212,584), which is the flattening, the accelerator parsing, the
NSMenu construction and the retained callback. Same shape as every other
platform API here: what you pay is what you call.

#### Still macOS-only

Two obstacles, both in code janela vendors rather than owns. webview.h's win32
message loop calls `TranslateMessage` and `DispatchMessageW` but never
`TranslateAcceleratorW`, without which Windows menu accelerators do not fire.
And the GTK backend keeps both GTK 3 and GTK 4 alive, where GTK 4 removed
`GtkMenuBar` in favour of `GMenu`. Upstream leaves menus to the embedder on
purpose — [webview/webview#127](https://github.com/webview/webview/issues/127)
is open, and [#237](https://github.com/webview/webview/pull/237), which added
exactly the Edit menu above, was closed with "anyone who is impatient can
always take this code on their own".

## Windows: GUI subsystem

A console-subsystem `.exe` makes Windows open a console window behind the UI.
The normal fix is `-mwindows` at link time, and **scriptc exposes no way to
pass a linker flag**:

- `system_libraries` entries are validated as bare library names and rejected
  outright if they start with `-`,
- `libraries` entries must resolve to existing files,
- no environment variable is read for extra link flags.

(Re-checked in `@scriptc/compiler` 0.0.36: `dist/ffi/profile.js`,
`dist/backend/cc.js`. Still true — and scriptc's own PR for
[#259](https://github.com/vercel-labs/scriptc/issues/259) was closed
unmerged, so there is no linker-flag route on the horizon.)

So `janela build` rewrites the `Subsystem` field in the linked PE instead —
from `IMAGE_SUBSYSTEM_WINDOWS_CUI` (3) to `IMAGE_SUBSYSTEM_WINDOWS_GUI` (2).
The entry point is untouched: MinGW's `mainCRTStartup` runs either way, and the
field only tells the loader whether to allocate a console. Every offset is
validated before a byte is written, and anything that is not a
console-subsystem PE is left alone.

**The trade-off**: a GUI-subsystem process has no console, so `console.log`
from a command goes nowhere on Windows. `janela dev` therefore keeps the
console subsystem — logs while developing, no console window when shipping.
