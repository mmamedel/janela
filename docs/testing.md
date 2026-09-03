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

## Failing loudly

The rule above is about the *page*. The same rule applies to the *harness*:
**a run that covers less than it was asked to must not be able to look green.**
Every hole below was real, and each one reported success.

| What was asked | What happened | Reported |
|---|---|---|
| `JANELA_E2E_TARGETS=ios,android` | nothing reads that name; the desktop lane ran | `# pass 3`, exit 0 |
| `JANELA_TEST_TEMPLATES=` | no templates selected, so no battery was defined | `# pass 1`, exit 0 |
| `JANELA_TEST_LANES=ios` with no simulator booted | reported as a node:test skip | exit 0 |

The first is the instructive one. `JANELA_E2E_TARGETS` was a plausible guess at
a real knob, the suite ignored it completely, and the three desktop tests that
ran looked exactly like three iOS tests passing — the count is identical and
nothing in the output named a lane. The coverage the caller asked for did not
merely fail, it never existed, and there was no way to tell from the result.

So `lib/env.mjs` holds the whole environment contract and enforces it before
the first test is defined:

- an unrecognised `JANELA_*` variable is an **error**, with a suggestion when
  a real knob is close and the full list always;
- a selector that resolves to nothing is an **error** — never an empty run;
- an unknown lane or template name is an **error**;
- a lane selected with no device attached is an **error**, not a skip, because
  a skip exits 0. `JANELA_TEST_SKIP_UNAVAILABLE=1` accepts the gap and the run
  says what it dropped, but it may not reduce the run to nothing.

Every run also opens by naming the lanes, templates and knobs it is about to
use, and closes with what it actually covered:

```
janela e2e — 1 lane(s) x 2 template(s)
  lanes:     desktop
  templates: vanilla, vue
  knobs set: (none — all defaults)
…
janela e2e — ran 3/3 test(s): desktop/vanilla, desktop/vue, desktop/quit
```

A bare pass count could never distinguish three desktop tests from three iOS
ones. Now the log says which.

### A log is not a pipe

The desktop lane reads a pipe: everything in it belongs to the run that just
finished. The device lanes read a **log** — a time window that also holds
earlier runs, of other templates, from other invocations. Three bugs came from
conflating the two, and the iOS lane could not go green for two of them:

- a **result** line is accepted only if its payload carries this run's nonce,
  so a passing line from an earlier run cannot satisfy an assertion this build
  never emitted;
- an **unparseable** line, and a **page error**, are now attributed the same
  way. They were not, so a malformed line left in the window by an earlier run
  of a *different template* failed whichever run read it next — observed as
  `ios · vanilla` failing on a payload whose run id was an earlier `ios · vue`;
- `log show` renders a literal backslash as the octal escape `\134`, so a
  payload with a JSON `\n` arrives as `\134n`. `\1` is not a valid JSON
  escape, so **every** result line containing a newline failed to parse — which
  made `framework-mounted` report as MISSING on every framework template even
  though the page had emitted `pass:true`. The app was right; the reader was
  wrong. The iOS lane undoes that escaping before parsing.

The last two are why a broken lane is worse than a missing one: a lane that is
red for reasons unrelated to the product is a lane people learn to ignore.

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
| `JANELA_TEST_SKIP_UNAVAILABLE` | unset | tolerate a selected lane with no device |
| `JANELA_TEST_BIG_MB` | `32` | size of the file the large-read assertions stage |
| `JANELA_TEST_SYNC_MAX_MS` | `150` | sync latency bound while async work is pending |
| `JANELA_TEST_DRAIN_P99_MAX_MS` | `50` | ping tail bound during the large read |
| `JANELA_TEST_ASYNC_MS` | `300` | delay the async command sleeps for |
| `JANELA_TEST_RUN_TIMEOUT_MS` | `300000` | per-run budget |
| `JANELA_TEST_KEEP` | unset | keep fixture projects that passed |
| `JANELA_TEST_SCRATCH` | `.janela-tests/` | where fixtures are built |
| `JANELA_TEST_QUIT_SLACK_MS` | `60000` | slack over the 5s timer when judging quit time |

This table is the same list `lib/env.mjs` enforces, and a test asserts they
match — a knob documented but not read, or read but not documented, fails the
suite. Anything not in it is rejected outright.

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

The harness's own guards are asserted the same way — a guard that cannot fail
is the bug it was written to prevent:

| Mutation | Caught by |
|---|---|
| the unknown-variable gate accepts everything | `an unknown JANELA_ variable is rejected and named` |
| an empty selector is allowed to select nothing | `a selector that selects nothing is an error` |
| an unknown lane or template name is allowed | `a selector naming something unknown is an error` |
| an unavailable lane is silently skipped again | `selecting a lane with no device is an error` |
| result lines stop being run-scoped | `a result line from another run cannot satisfy…` |
| error lines stop being run-scoped | `a page error is attributed to its own run` |
| the `log show` unescaper becomes a no-op | `os_log's escaped backslash is undone before parsing` |

Those live in [`tests/e2e/contract.test.mjs`](../tests/e2e/contract.test.mjs),
which builds nothing and runs in about 40 ms, so it gates every run.

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

## Size figures

`pnpm check:sizes` gates the published numbers against `docs/sizes.json`, at
three levels of strictness — and the levels exist because the surfaces differ
in how much a script can legitimately own:

| surface | how it is held | what fails |
|---|---|---|
| the table in `docs/frontend.md` | **generated** from the record | any hand-edit — run `--write` |
| every `N–M KB` span in the READMEs, the site and the docs | **checked**: each must bracket a real spread | a range that brackets nothing, or one so wide it says nothing |
| the site's per-platform table | **checked cell by cell** against the record | a drifted figure, a dropped cell, a retitled row, a platform the record has and the page doesn't |

The third one is `checkSiteFigures`, and it was added because the second one
cannot see single absolute figures. The landing page quotes six of them, they
were correct when written, and nothing would have noticed them coming loose —
on the one surface a reader actually sees. It reads the page rather than
generating it, because the markup and its classes are design, not data; so a
row it does not recognise is an error rather than a row it skips.

`tests/e2e/sizes.test.mjs` covers that checker the way this suite covers
itself: eleven tests that mutate the page in memory and require the guard to go
red *for the stated reason*. Verified against a weakened checker — neutering
the cell comparison reddens 3, letting an unknown row fall through to the first
platform reddens 1, and making the checker return nothing reddens 9.

**What is still not gated:** the byte-level figures in the prose of
[`frontend.md`](frontend.md) — `177,024–177,072 B off the iOS binary`, `409,232
-> 232,208`, the 178 KB upstream prize. Those are *deltas against
pre-strip artifacts*, and the record holds only what the current version
measures, so there is nothing to check them against without keeping a history
of every past build. They are correct as measured on 2026-09-03; treat them as
prose that dates, and re-derive rather than copy them.

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
- **Byte-level size deltas in prose are not gated** — only ranges and the
  site's absolute table are. See [Size figures](#size-figures).
- **Warm-up is excluded from the latency numbers.** The battery pings 20 times
  before measuring, because the first invoke includes webview startup and has
  masqueraded as the metric before.
