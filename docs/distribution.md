# Distribution

Turning a `janela build` into something you can hand to someone else.

Everything here is opt-in. A project with no `bundle` section and no `icon.png`
builds exactly as it always has.

## Icons

Put a square PNG at `icon.png` beside `janela.conf.json` — 1024×1024 is a good
source size — or point at one explicitly:

```json
{
  "name": "my-app",
  "bundle": { "icon": "assets/logo.png" }
}
```

`janela build` then produces what each platform wants:

| Target | What is generated | Where it goes |
|---|---|---|
| macOS | `.icns` (16–1024 px, @1x and @2x) | `MyApp.app/Contents/Resources/`, wired via `CFBundleIconFile` |
| Windows | `.ico` (16/32/48/64/128/256, PNG payloads) | beside the `.exe` |
| iOS | 8 PNGs (40–1024 px) | app bundle root, listed in `CFBundleIconFiles` |
| Android | `ic_launcher.png` at five densities | `res/mipmap-{m,h,xh,xxh,xxxh}dpi/`, referenced by `android:icon` |

Icon generation uses `sips` and `iconutil`, which ship with macOS, so it
currently requires building on a Mac — already true of `.app`, `.dmg` and iOS
output. On other hosts the build prints a warning and continues without an
icon rather than failing.

The Windows `.ico` is written *beside* the executable rather than embedded in
it: embedding needs a resource compiler we cannot assume is present. Installers
and shortcuts both take an icon path, so this is enough in practice.

## macOS: `.dmg`

```json
{ "bundle": { "dmg": true } }
```

`janela build` then also produces `.janela/out/<name>-<version>.dmg` — a plain
drag-to-Applications image containing the `.app` and an `Applications` symlink.
It is off by default because a disk image is for shipping, not for iteration.

The `.app` inside is **ad-hoc signed**, which is fine for your own machine and
for a colleague who is willing to right-click → Open. For anything wider, see
signing below.

## macOS: signing and notarization

Not automated, and it needs an Apple Developer account ($99/year). What a
release actually requires:

1. A **Developer ID Application** certificate in your Keychain.
2. Re-sign the bundle with the hardened runtime, replacing janela's ad-hoc
   signature:
   ```sh
   codesign --force --deep --options runtime --timestamp \
     --sign "Developer ID Application: Your Name (TEAMID)" \
     .janela/out/my-app.app
   ```
3. Notarize the `.dmg` and staple the ticket:
   ```sh
   xcrun notarytool submit my-app-0.1.0.dmg \
     --apple-id you@example.com --team-id TEAMID --password "$APP_PASSWORD" --wait
   xcrun stapler staple my-app-0.1.0.dmg
   ```

Without steps 2 and 3, Gatekeeper will refuse the app on another machine with
"cannot be opened because the developer cannot be verified".

## Android: release signing

By default the APK is signed with a throwaway debug key kept in
`.janela/cache/` — enough to install on a device or emulator, and rejected by
Google Play.

To sign with a real key, create the keystore yourself (janela will never
generate or store one) and point at it:

```sh
keytool -genkeypair -v -keystore release.jks -alias upload \
  -keyalg RSA -keysize 2048 -validity 10000
```

```json
{
  "bundle": {
    "androidKeystore": {
      "path": "release.jks",
      "alias": "upload",
      "storePasswordEnv": "JANELA_ANDROID_STORE_PASSWORD",
      "keyPasswordEnv": "JANELA_ANDROID_KEY_PASSWORD"
    }
  }
}
```

The passwords are read from the **environment**, never from the config file:

```sh
export JANELA_ANDROID_STORE_PASSWORD=…
janela build --target android
```

If the keystore is configured and the environment variable is missing, the
build fails and says which variable it wanted — it does not silently fall back
to the debug key. Keep `release.jks` out of version control; losing it means
you can never update an app already on Play.

## iOS: device builds and the App Store

**Not supported yet.** `janela build --target ios` produces a **simulator**
bundle (`CFBundleSupportedPlatforms: iPhoneSimulator`), which cannot be
installed on a phone.

A device build needs, at minimum: an Apple Developer account, a Team ID, an
App ID, a provisioning profile matching the bundle identifier, and a signing
identity in the Keychain. The build itself would also have to change — the
scriptc target becomes `aarch64-apple-ios` rather than
`aarch64-apple-ios-simulator`, the platform key becomes `iPhoneOS`, the bundle
needs an embedded provisioning profile and entitlements, and shipping means
wrapping it in an `.ipa` (a zip with the app under `Payload/`) and uploading
through `xcrun altool`/Transporter.

None of that can be implemented or tested without an account, so it is
deliberately absent rather than half-built. If you need it, an Xcode project
that links the archive janela already produces is the pragmatic route today —
see [ios.md](ios.md) for how the library is built.

## Windows: installers

**Not automated, by design.** janela's Windows executable is produced by
building *on* Windows (the shim needs an llvm-mingw clang), so there is no
`.exe` on a Mac or Linux host to wrap. Cross-building an installer where the
payload does not exist is not useful.

On a Windows machine, the pieces are all in place — `janela build` gives you
`.janela\out\my-app.exe` plus `my-app.ico` — and any standard installer tool
takes it from there. An untested-by-us NSIS sketch, to adapt:

```nsi
!define NAME "my-app"
Name "${NAME}"
OutFile "${NAME}-setup.exe"
InstallDir "$LOCALAPPDATA\${NAME}"
Icon ".janela\out\${NAME}.ico"
Section "Install"
  SetOutPath $INSTDIR
  File ".janela\out\${NAME}.exe"
  File ".janela\out\${NAME}.ico"
  CreateShortcut "$SMPROGRAMS\${NAME}.lnk" "$INSTDIR\${NAME}.exe" "" "$INSTDIR\${NAME}.ico"
  WriteUninstaller "$INSTDIR\uninstall.exe"
SectionEnd
```

Signing an installer needs an Authenticode certificate; unsigned installers
trigger SmartScreen warnings.

This is a candidate for automation later: janela's own CI already runs a
`windows-latest` job, so the installer could be produced there.

## Configuration reference

Everything below is optional.

```json
{
  "bundle": {
    "icon": "icon.png",
    "dmg": false,
    "androidKeystore": {
      "path": "release.jks",
      "alias": "upload",
      "storePasswordEnv": "JANELA_ANDROID_STORE_PASSWORD",
      "keyPasswordEnv": "JANELA_ANDROID_KEY_PASSWORD"
    }
  }
}
```

- `icon` — path to a square PNG, relative to the project root. Defaults to
  `icon.png` if that file exists.
- `dmg` — also build a macOS disk image.
- `androidKeystore` — sign the APK with your own key instead of the debug key.
  `keyPasswordEnv` defaults to `storePasswordEnv`.

## Status

| Platform | Runnable artifact | Distributable artifact |
|---|---|---|
| macOS | `.app` (ad-hoc signed) | `.dmg`; signing and notarization are manual |
| Linux | executable | none yet (no AppImage/deb/rpm) |
| Windows | `.exe` + `.ico` | installer is manual, on Windows |
| iOS | simulator `.app` | none — device builds need an Apple account |
| Android | debug-signed APK | release-signed APK with your keystore |
