# Native shell: dialogs, window control, Windows subsystem

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
