#!/usr/bin/env bash
# SPIKE — build recipe for an iOS janela app (simulator).
set -euo pipefail
cd "$(dirname "$0")"

SC=../../packages/janela/node_modules/.bin/scriptc
SDK="$(xcrun --sdk iphonesimulator --show-sdk-path)"
TRIPLE="arm64-apple-ios15.0-simulator"
APP="build/Janela.app"

echo "==> compiling TypeScript to an iOS static library"
SCRIPTC_CC=zigcc SCRIPTC_TARGET=aarch64-apple-ios-simulator "$SC" build --lib --profile profile.json

echo "==> compiling and linking the UIKit shell"
rm -rf build && mkdir -p "$APP"
xcrun clang++ app.mm \
  -target "$TRIPLE" -isysroot "$SDK" \
  -fobjc-arc -std=c++17 -O2 \
  -framework UIKit -framework WebKit -framework Foundation \
  .scriptc/lib.lib.a \
  -o "$APP/Janela"

cat > "$APP/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Janela</string>
  <key>CFBundleDisplayName</key><string>Janela</string>
  <key>CFBundleIdentifier</key><string>dev.janela.iosspike</string>
  <key>CFBundleExecutable</key><string>Janela</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleShortVersionString</key><string>0.1</string>
  <key>LSRequiresIPhoneOS</key><true/>
  <key>UILaunchScreen</key><dict/>
  <key>MinimumOSVersion</key><string>15.0</string>
  <key>CFBundleSupportedPlatforms</key><array><string>iPhoneSimulator</string></array>
</dict>
</plist>
PLIST

echo "==> built $APP ($(stat -f%z "$APP/Janela") bytes)"
