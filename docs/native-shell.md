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

## Menus

Two separate things live under this heading, and conflating them is the source
of most of the confusion:

- **the standard bar**, which exists on macOS only and needs no API, and
- **`app.setMenu`**, which renders your own menus on all three desktops.

### macOS: the standard bar

Every janela app installs a standard macOS main menu. There is no API for it
and nothing to call — it is set up in the shim right after the webview exists,
and it is a no-op on Windows and Linux.

It is there because **on macOS a Command-key shortcut is a menu key
equivalent, not a window-manager gesture.** With no main menu nothing claims
⌘Q, ⌘C, ⌘V, ⌘X, ⌘Z or ⌘A, and the app silently ignores all of them — an app
window with a text input where paste does nothing. Alt+F4 on Windows is
unaffected by any of this: it is a `WM_CLOSE` the win32 backend already
answers, and the editing keys are handled inside WebView2 and WebKitGTK. So
this floor is a macOS-only fix, and an app that never calls `setMenu` correctly
has a full menu bar there and none elsewhere.

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

A menu item is an **object that carries its own handler**. There are no ids —
nothing to declare, nothing to match, nothing to mistype.

```ts
import { menuItem, menuSeparator, submenu } from "janela/host";

const save = menuItem("Save", "CmdOrCtrl+S", () => writeDocument());

app.setMenu([
  submenu("File", [
    menuItem("Open…", "CmdOrCtrl+O", () => openDocument()),
    menuSeparator(),
    save,
    submenu("Recent", [menuItem("Clear", "", () => clearRecents())]),
  ]),
]);

save.setEnabled(false);          // later, without rebuilding
save.setLabel("Save As…");
```

A tick needs `menuCheckItem`, not `menuItem`:

```ts
const dark = menuCheckItem("Dark mode", "", () => toggleTheme());
dark.setChecked(true);
```

`setChecked` exists only on those, and calling it on a plain item is a compile
error. That is GTK's constraint made visible: a tick needs `GtkCheckMenuItem`,
a different widget chosen at construction, and an item cannot become one later.
macOS and Windows would allow any item to carry a check — but a method that
works on two platforms and silently does nothing on the third is worse than one
that is simply absent.

Keep the reference if you want to change an item later; there is no lookup,
because there is no name to look up by. For a menu built from data, keep your
own map:

```ts
const items = new Map(docs.map((d) => [d.id, menuItem(d.name, "", () => open(d))]));
items.get("a")?.setEnabled(false);
```

`setMenu` replaces what a previous call installed, so the menu can shrink as
well as grow. On macOS **the application submenu is always prepended** to
whatever you declared — partly because it is the floor under ⌘Q, and partly
because AppKit turns the main menu's *first* item into the app menu whatever it
is titled, so a menu starting with `File` would otherwise be rendered as the
app menu and labelled with the bundle name.

Modifiers in `accel`: `Cmd`, `Ctrl`, `CmdOrCtrl`, `Alt`/`Option`, `Shift`. Pass
`""` for no shortcut. `CmdOrCtrl` is Command on macOS and Control elsewhere;
the runtime sends the *intent* rather than a platform constant, which is the
only way one accelerator string can mean the right thing on three platforms —
the renderer maps it to `NSEventModifierFlags`, an `ACCEL.fVirt`, or GTK's
`<Primary>`. The mask is always set explicitly, including empty, because
AppKit's default for a key equivalent is Command — so an accelerator with no
modifiers would silently become a Command shortcut.

Key names beyond a single character: `F1`–`F24`, `Enter`/`Return`, `Escape`,
`Space`, `Tab`, `Backspace`, `Delete`, `Insert`, `Up`, `Down`, `Left`, `Right`,
`Home`, `End`, `PageUp`, `PageDown`.

#### Why there are no ids

Tauri's menu crate, [muda](https://github.com/tauri-apps/muda), gives every
item a `MenuId(String)` and delivers clicks on a global channel, so you match
the id afterwards:

```rust
pub struct MenuId(pub String);
impl<T: ToString> From<T> for MenuId { … }   // anything stringifiable is an id
```

That is not a design choice so much as a Rust constraint: a closure cannot
easily be attached to an item across a global static channel, so a name has to
stand in for it — and a typo in the match arm is silent. TypeScript has no such
problem. Attaching the handler to the item removes the name, and with it the
whole class of bug that typing the name would have been protecting against.

One implementation note, silent when got wrong: **the tag is assigned in
TypeScript**, not by the renderer. It indexes the handler registry, is written
into the wire format, comes back on a click, and is what the setters address.
Handlers live in an array rather than on the item, because scriptc cannot call
a closure held on an object property (`SC1090`) — the same reason command
handlers live in one.

#### What it costs

Almost nothing unless you call it. An app that never mentions `setMenu` pays
**272 bytes** for three renderers being present in the source, because scriptc
tree-shakes the unused runtime and the linker dead-strips the shim's menu code
— and on macOS arm64 the 16 KB segment alignment absorbs what is left.

Using it is what costs. The File menu the templates now ship — a submenu, two
items, a separator, an accelerator each and one `predefined` call — costs
**33,328 bytes** (196,064 → 229,392): the flattening, the accelerator parsing,
the native menu construction, the retained callback and the three setters.
`predefined` itself is free: dropping it and calling `app.quit()` instead
measured 16 bytes *larger*. Same shape as every other platform API here — what
you pay is what you call.

#### Platform actions

Some menu items are not "run my function". Paste is `paste:` travelling up the
AppKit responder chain — a TypeScript closure cannot do it, because a webview
blocks `document.execCommand("paste")`. So the behaviour has to come from the
platform, and `predefined` exposes those actions as ordinary functions:

```ts
import { menuItem, predefined } from "janela/host";

const close = menuItem("Close", "CmdOrCtrl+W", () => predefined.close());
const copy  = menuItem("Copy",  "CmdOrCtrl+C", () => predefined.copy());

// and they compose, which a fixed "predefined item" never could
menuItem("Save and close", "", () => { write(); predefined.close(); });
```

They are callable from anywhere, not only from a menu. Each returns `false`
where the platform has no equivalent, and an item built on an unavailable one
is dropped from the bar rather than rendered dead:

| action | macOS | Windows | Linux |
|---|---|---|---|
| `quit` `close` `minimize` `zoom` `fullscreen` | ✓ | ✓ | ✓ |
| `undo` `redo` `cut` `copy` `paste` `selectAll` | ✓ | — | ✓ |
| `about` `hide` `hideOthers` `showAll` | ✓ | — | — |

The Windows gap is WebView2's: it runs the page out of process and exposes no
copy/paste entry point. It handles Ctrl+C/X/V/Z/A itself, so **the keys work
there** — only a menu *item* for them cannot. WebKitGTK does expose the
commands (`webkit_web_view_execute_editing_command`), which is why Linux has
them.

#### What each renderer had to solve

Upstream leaves menus to the embedder on purpose —
[webview/webview#127](https://github.com/webview/webview/issues/127) is open,
and [#237](https://github.com/webview/webview/pull/237), which added exactly
the Edit menu above, was closed with "anyone who is impatient can always take
this code on their own". So all three renderers are janela's, and each had one
non-obvious obstacle:

**macOS.** `autoenablesItems: NO` on every submenu. AppKit otherwise decides
each item's enabled state from the responder chain and ignores `setEnabled:`
entirely — the item stays live however many times you disable it.

**Windows.** Accelerators need `TranslateAcceleratorW`, and webview.h's message
loop never calls it: `run_impl` is `GetMessageW` / `TranslateMessage` /
`DispatchMessageW` and nothing else. We do not own that loop — but a
`WH_GETMESSAGE` hook runs *inside* its `GetMessageW`, which is the same point
in the cycle. On a hit the message is rewritten to `WM_NULL`, which is how the
key stops there instead of also reaching the page. Clicks arrive as `WM_COMMAND`
on a subclassed wndproc that chains to webview.h's own.

**Linux.** A `GtkWindow` is a `GtkBin` and holds exactly one child, and the
backend puts the webview there — so a menu bar means re-parenting the webview
into a `GtkBox` first. It is done once and remembered on the box, so a later
`setMenu` swaps the bar rather than nesting another box. The backend also
parents the webview *lazily*, in `window_show()`, which runs on the first
`setSize`; a `setMenu` that arrives before it would leave `window_show()`
adding the webview to a `GtkBin` that is already full — a GTK warning and a
blank window. So an unparented window means "not yet" and the render is retried
at `run()`. And `gtk_check_menu_item_set_active` emits `activate`, so
`setChecked` blocks the item's own handler for the duration: otherwise the host
reflecting state would invent a click.

GTK 4 is the one platform that returns `false`: it removed `GtkMenuBar` in
favour of `GMenuModel`, a different model with a different lifetime. The build
pins `gtk+-3.0`, so that path is compiled out rather than guessed at.

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
