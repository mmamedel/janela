# Template × platform matrix — raw evidence

Run at 0.12.0 on 2026-08-31. macOS 26.5 arm64; iPhone 17 Pro simulator
(iOS 26.5); `Medium_Phone_API_36.0` emulator (API 36, arm64-v8a, System WebView
133.0.6943.137).

Each cell was scaffolded fresh, `npm install`ed (except `vanilla`),
typechecked where the template ships a `typecheck` script, built, installed and
**run**. A probe appended to `index.html` as a *classic* (non-module) script —
so Vite leaves it untransformed and the same fixture works for every template —
waited for the framework to render host data into the DOM, then exercised a
typed round trip and a Unicode round trip.

The probe asserts three things, not one: that the framework actually mounted
(`rendered=yes`, meaning the host's greeting reached the DOM), that a typed
command returned a `number` rather than a string (`add=42 typeof=number`), and
that `— çãé 🚀` survived both directions (`unicode=yes`).

## Results — 15/15 pass

| template | desktop | iOS simulator | Android emulator |
|---|---|---|---|
| vanilla | pass | pass | pass |
| vue | pass | pass | pass |
| react | pass | pass | pass |
| svelte | pass | pass | pass |
| solid | pass | pass | pass |

Desktop and iOS were read from process output and the unified log respectively;
Android was read from the screen, because host `console.log` does not reach
`logcat` (see [android.md](../android.md)).

## Raw sizes (bytes)

| template | desktop binary | iOS `.app` binary | Android `.apk` | Android `.so` |
|---|---|---|---|---|
| vanilla | 481,832 | 392,136 | 471,563 | 1,388,280 |
| solid | 465,272 | 375,592 | 475,659 | 1,390,936 |
| svelte | 498,296 | 408,616 | 483,851 | 1,419,144 |
| vue | 531,320 | 441,640 | 496,139 | 1,445,560 |
| react | 663,416 | 573,752 | 528,907 | 1,575,208 |

## Sample output

Desktop (`m-react`):

```
[host] page says: CELL-OK react rendered=yes unicode=yes add=42 typeof=number
[janela] run returned 0
```

iOS (`m-svelte`, from `log show --predicate 'subsystem == "dev.janela"'`):

```
m-svelte[14487] [dev.janela:host] [host] page says: CELL-OK svelte rendered=yes unicode=yes add=42 typeof=number
```

Android: rendered on screen, captured with `adb exec-out screencap` —
`docs/img/android-{vanilla,vue,react,svelte,solid}.png`.

## Two measurement notes

**`run returned 0` is not a pass.** A page whose script throws still exits 0.
Every cell here was judged by the presence of the `CELL-OK` marker, never by
exit status.

**Headless `--window-size` is not a mobile viewport.** A first attempt at
checking the website for horizontal overflow used Chrome's
`--headless --window-size=390,844 --screenshot`, which renders at desktop
layout width and crops — the screenshot looked badly broken. Measured properly
through a real 390px viewport, `document.documentElement.scrollWidth` equals
`window.innerWidth` at 1280, 390 and 320. The screenshot was wrong, not the
page.
