# Android

janela apps build and run on Android. Commands, events, async and file I/O
behave exactly as they do on desktop and iOS — the same TypeScript runtime is
compiled for all three, and only the shell around it differs.

```bash
janela build --target android   # -> .janela/out-android/<name>.apk
janela dev   --target android   # build, boot an emulator, install, launch, follow logcat
```

## What you need

| | |
|---|---|
| JDK | 17 or newer (`brew install openjdk`), or `JAVA_HOME` set |
| Android SDK | with `platform-tools`, `build-tools`, and a platform (`android-36`) |
| NDK | `sdkmanager --install "ndk;27.0.12077973"`, or `ANDROID_NDK_ROOT` |
| zig | `brew install zig` — scriptc routes mobile targets through `zig cc` |

The SDK is found through `ANDROID_HOME`, `ANDROID_SDK_ROOT`, or
`~/Library/Android/sdk`. There is no Gradle in the build: the CLI drives
`aapt2`, `d8`, `zipalign` and `apksigner` directly, which is why a project
needs no Android project files of its own.

Builds target `arm64-v8a` and are signed with a debug key generated once into
`.janela/cache`. That is enough for an emulator or your own device; a release
key is not wired up yet.

## Configuration

`janela.conf.json` takes an optional `android` section. Every field falls back
to something already in the file, so it is only needed when the defaults are
wrong:

```json
{
  "name": "my-app",
  "identifier": "dev.example.myapp",
  "android": {
    "applicationId": "dev.example.myapp",
    "label": "My App",
    "minSdk": 26,
    "device": "Medium_Phone_API_36.0"
  }
}
```

`applicationId` defaults to `identifier`, `label` to the window title, and
`device` to the first AVD `janela dev` finds.

One wrinkle worth knowing: an Android application id is a Java package name, so
it cannot contain hyphens. A project called `my-app` gets the default
identifier `dev.janela.my-app`, which is fine everywhere else and illegal here,
so each segment is coerced (`dev.janela.my_app`) rather than failing the build.
Set `android.applicationId` explicitly if you care what it is — and you should
before publishing anything, because it is the permanent identity of the app on
the Play Store.

## What works, and what does not yet

Working: typed commands, `app.emit` → `janela.listen`, `commandAsync`,
`app.sleep`, `app.defer`, `readFileAsync` / `writeFileAsync`, and every
frontend template.

Not yet on Android — parity is planned:

- **Native dialogs.** The desktop file pickers have no Android implementation
  yet; the equivalent is `Intent.ACTION_OPEN_DOCUMENT` with its own result
  plumbing.
- **Window control.** `setTitle` sets the Activity label, which shows in the
  task switcher. `setSize` and `setFullscreen` are no-ops: a phone's window is
  the screen. These report success rather than failing so that portable code
  does not have to branch on the platform.

Both are refused through the same single guarded path the iOS lane uses, so
they can be implemented by editing one place.

## Where files go

A relative path handed to `readFileAsync` or `writeFileAsync` resolves against
the app's private files directory — the one place a sandboxed Android app can
freely read and write. There is no useful working directory, and host paths
from your development machine do not exist on the device.

## How it fits together

Android has no `main()`. The system creates the Activity and owns the Looper,
so janela's shell is a shared library the Activity loads, and everything starts
from `onCreate`. That is the same inversion as iOS, and it is why the
scheduling work in 0.9.0 came first: the TypeScript runtime parks a
continuation under an id and waits to be called back, so the shell can own the
clock on whichever platform it happens to be.

The web view itself is driven through `webview.h`'s Android backend, which
janela vendors. Unlike every other backend in that library it is not
self-sufficient: `android.webkit.WebView` is a Java API, every framework
callback arrives as a virtual Java method, and native code cannot define a
class to receive one, so a small companion Java class ships in the APK. See
the header for the full reasoning.
