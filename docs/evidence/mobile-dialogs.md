# Mobile file dialogs — evidence

`openFileDialog` on iOS and Android, and Android host logging. Captured
2026-08-31 on the iPhone 17 Pro simulator (iOS 26.5) and the
`Medium_Phone_API_36.0` emulator (API 36, arm64-v8a).

## Android — driven end to end

`adb shell input` can drive the picker, so every step below was executed.

    DIRPICK err=ENOTSUP: picking a directory is not supported on Android
    PROBE presenting picker
    DIALOG copied=/data/user/0/dev.janela.dlg_and/files/picked/pickme.txt len=24 exact=true
    DIALOG cancelled=true

- an unsupported option reports rather than silently opening a file picker;
- the picked file is copied into app storage under **its own name** (an
  earlier revision named it `3A18`, after the content:// URI's opaque
  document id — the Activity now resolves `OpenableColumns.DISPLAY_NAME`);
- `readFileAsync` opens the copy and `— çãé 🚀` survives (`exact=true`);
- back-out answers `null`, matching desktop.

Screenshot: `img/android-dialog.png`.

## iOS — presented, not driven

    DIRPICK err=ENOTSUP: picking a directory is not supported on iOS
    PROBE now presenting the real picker

The `UIDocumentPickerViewController` presents (`img/ios-dialog.png` shows
Recents / Search / Browse). **The pick and cancel paths were not executed on
iOS**: `simctl` has no touch input and `idb` is not installed here, so there
is no way to tap the picker from a script. The delivery path either side of
the tap *is* exercised — the channel, the job table, the copy helper and
`onDialogDone` are the same code Android runs — but the
`UIDocumentPickerDelegate` callbacks themselves are verified by inspection
only. Worth re-testing by hand, or with `idb` installed.

## Android host logging

    I janela-host: LOGCAT-PROBE host console.log reached logcat — çãé 🚀
    I janela-host: [host] page says: page loaded

Tags are split: app output on `janela-host`, stderr on `janela-stderr`.
Replacing fd 2 captures everything in the process that writes to stderr, and
the emulator's GL driver produced 42 lines of its own in one run — so
`adb logcat -s janela-host:V` stays a clean view of what the app printed.

## Regression

- desktop: sync at t+0ms while async pending, async at t+307ms, UTF-8 exact,
  binary 481,832 bytes — byte-identical to the baseline;
- iOS parity: sync t+0ms, async t+316ms, fs round trip `exact=true`;
- Android APK 479,755 bytes (`.so` 1,405,368).
