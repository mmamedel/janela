# Testing janela

```bash
pnpm test          # the end-to-end suite, desktop lane
pnpm test:e2e      # same thing, named explicitly
```

janela is a compiler and a native shell, so almost nothing useful can be
asserted about it in-process. The suite therefore does the real thing: it
scaffolds projects with the real CLI, compiles them with the real toolchain,
runs the produced binary, and judges the run on what the page reports back.

## The one property that matters

**Exiting 0 is never a pass.** Every assertion the suite expects must be
*seen*. A binary that starts, does nothing and exits cleanly fails with
`MISSING assertion '…' — the page never reported it`.

That rule is not decoration. Each of the two false passes this harness has
produced was of exactly that shape — a page that never ran its checks, and a
grep over empty output that was happy about it. Two more safeguards come from
the same lesson:

- **Every reported line carries a per-run nonce**, and the parser drops lines
  that lack it. The device lanes read a log over a time window; matching a bare
  `JANELA_TEST_DONE` once reported a *previous* run's results as a pass while a
  real regression sat in front of it.
- **Fixture edits assert that they applied.** A silently no-op'd edit is the
  other half of that failure.

## What is asserted

One page, one battery, all lanes — the fixture is a classic (non-module)
inline script over `window.janela`, which is why the same file drives all five
templates without Vite transforming it.

| Assertion | What breaks if it regresses |
|---|---|
| `global-bridge` | the injected bootstrap never reached the page |
| `framework-mounted` | the Vite build is not flattened into the binary, or the component never got the host's reply (Vite templates only) |
| `sync-while-async-pending` | an in-flight async command blocks the window |
| `async-resolves-later` | the held-reply table never resolves the parked promise |
| `sleep-due-order` | the timer queue does not run timers in due order |
| `defer-next-turn` | a zero-delay defer does not land on the next turn |
| `async-reject` | a rejecting async command does not surface as a rejection |
| `emit-listen` | host → page events do not arrive |
| `unlisten-stops` | the unsubscribe returned by `listen` does not detach |
| `fs-roundtrip`, `fs-unicode` | async write/read loses bytes or mangles UTF-8 |
| `fs-missing-error`, `fs-directory-error` | error *values* lose their node code (`ENOENT:` / `EISDIR:`) or their path |
| `large-file-staged`, `large-read-correct` | a multi-megabyte staged read truncates |
| `large-read-bounded` | that read blocks the UI thread — the p50/p99/max of a ping running throughout |

Plus one separate test: quitting with a read and a 5 s timer in flight must
exit promptly and must not let the timer's continuation fire. It deliberately
tolerates the *read* finishing, because the shell joins fs workers at
shutdown — that is correct behaviour, not a leak.

## Lanes

| Lane | Needs | In CI |
|---|---|---|
| `desktop` | the platform toolchain; supplies its own Xvfb on Linux when `DISPLAY` is unset | yes, on Linux + macOS + Windows |
| `ios` | a **booted** simulator (`xcrun simctl boot …`) | no |
| `android` | a **booted** emulator (`emulator -avd …`) | no |

```bash
JANELA_TEST_LANES=desktop,ios,android pnpm test:e2e
JANELA_TEST_LANES=ios JANELA_TEST_TEMPLATES=vanilla pnpm test:e2e
```

A mobile lane with no device **skips**; it never fails and never silently
passes. Device lanes read `os_log` / `logcat` rather than stdout, and the app's
exit code is not observable there, so those lanes are judged purely on the
assertions — which is the stronger signal anyway.

## Knobs

| Variable | Default | Meaning |
|---|---|---|
| `JANELA_TEST_LANES` | `desktop` | comma-separated lanes |
| `JANELA_TEST_TEMPLATES` | `vanilla,vue` | any of `vanilla,vue,react,svelte,solid` |
| `JANELA_TEST_BIG_MB` | `32` | size of the file the large-read assertions stage |
| `JANELA_TEST_SYNC_MAX_MS` | `150` | sync latency bound while async work is pending |
| `JANELA_TEST_DRAIN_P99_MAX_MS` | `50` | ping tail bound during the large read |
| `JANELA_TEST_ASYNC_MS` | `300` | delay the async command sleeps for |
| `JANELA_TEST_RUN_TIMEOUT_MS` | `300000` | per-run budget |
| `JANELA_TEST_KEEP` | unset | keep fixture projects that passed |
| `JANELA_TEST_SCRATCH` | `.janela-tests/` | where fixtures are built |

Failing fixtures are kept regardless of `JANELA_TEST_KEEP` — the built project
is the only record of what was actually compiled and run, and CI uploads it.

## Is the suite actually load-bearing?

Asserted by breaking the product on purpose and checking the suite notices.
Restore is by file copy, not `git checkout`, because sibling worktrees share
the index.

| Mutation | Caught by |
|---|---|
| timer queue picks the latest due timer instead of the earliest | `sleep-due-order`, `defer-next-turn` |
| the unsubscribe returned by `janela.listen` becomes a no-op | `unlisten-stops` |
| the fs error mapper loses its directory branch (`EISDIR` → `EIO`) | `fs-directory-error` |
| the `ENOENT` message reports the wrong path | `fs-missing-error` |

The third one is worth keeping in mind: it **passed** against the first
version of that assertion, which only required "some error". The assertion's
name promised more than it checked. Tightening it to demand the node code and
the path is what made the mutation fail. When adding an assertion, prefer the
exact contract over a truthiness check — otherwise the mutation table above
will keep growing rows that pass.

The suite also has two product bugs to its name, both of which the previous
inline CI smoke could not have seen:

- `readFileAsync` on a directory resolved with an empty string on iOS and
  Android instead of failing — desktop already answered `EISDIR`.
- **`janela build` was broken on Windows for every Vite template.** The CLI
  spawned `node_modules/.bin/vite.cmd`, and since the CVE-2024-27980 fix Node
  refuses to spawn a `.cmd` without a shell, so the build died with `EINVAL`.
  `janela dev` passed `shell: true` and worked, which is why nothing noticed.
  It now runs vite's own JS entry with this Node — no shim, no shell, the same
  on every platform.

## CI

`.github/workflows/ci.yml` runs the suite on `ubuntu-latest`,
`macos-latest` and `windows-latest`. Windows installs llvm-mingw first:
scriptc's runtime needs a full mingw-w64 (`ssize_t`, `nanosleep`,
`clock_gettime`) and MSVC's clang cannot build it.

CI relaxes the two timing bounds (`JANELA_TEST_SYNC_MAX_MS=750`,
`JANELA_TEST_DRAIN_P99_MAX_MS=300`). A shared runner cannot honestly hold a
50 ms drain p99 — that measures the neighbours, not janela. The relaxed bounds
still catch the regression they exist for, a blocking read that stalls the UI
thread for whole seconds, and the tight local defaults remain the real
performance gate.

## Not covered

Worth knowing before trusting a green run:

- **No mobile lane in CI** — no simulator or emulator on the runners. iOS and
  Android are verified locally, per change.
- **`react`, `svelte`, `solid`** are exercised on request, not by default;
  `vanilla` and `vue` cover the two build paths (no-bundler and Vite).
- **No window-level UI assertions** — no clicks, no screenshots. Everything is
  asserted through the bridge.
- **Dialogs, distribution and packaging** are not covered; they need a user or
  a signing identity.
- **Warm-up is excluded from the latency numbers.** The battery pings 20 times
  before measuring, because the first invoke includes webview startup and has
  masqueraded as the metric before.
