# Testing the typed contract and the CLI

Two suites live in `packages/janela/test/`, both runnable from that directory:

```bash
npm test           # both
npm run test:types # the typed IPC contract
npm run test:unit  # the CLI's pure decisions, plus its argument surface
```

They need `typescript`, which is a devDependency of the package; `pnpm install`
at the workspace root provides it.

## `test/types` — the contract is enforced, not merely present

janela's central claim is that a page checked against a host's contract cannot
call an undeclared command, pass the wrong arguments, misuse a result, or
subscribe to an event that does not exist — with no code generation, because
both sides are TypeScript and the frontend imports the host's own types.

The trap in testing that is that **"does it compile" proves almost nothing**.
If the contract types ever degraded to `any`, every reasonable-looking positive
test would still pass: `const n: number = await client.invoke("add", …)` is
happy when `invoke` returns `any`. So each fixture declares the diagnostic it
must produce, by code *and* by message:

```ts
// @expect TS2345 '"addd"' is not assignable to parameter of type '"add" | "greet" | "wait" | "quit"'
import type { App } from "./contract.ts";
export function setup(app: App): void {
  app.command("addd", () => 1);
}
```

The runner type-checks every fixture in one program, then asserts per fixture
that each expectation was met and that **nothing else** was raised. A fixture
annotated `// @expect-ok` must produce no diagnostics at all. A fixture with a
typo therefore cannot pass for the wrong reason.

Fifteen fixtures: eleven that must fail (six host-side, five page-side) and four
that must be clean — including `ok-contractless.ts` (the vanilla path, where any
command name is accepted) and `ok-legacy-record.ts` (the 0.5.x–0.7.x
`{ args; result }` form), so the back-compatibility promise is checked too.

`fail-page-result-not-any.ts` is the negative control, and the reason the suite
is trustworthy. It requires that assigning a `number` result to a `string` is an
error. Weaken `JanelaClient.invoke` to `Promise<any>` and it is the only fixture
that notices:

```
FAIL fail-page-result-not-any.ts
     expected TS2322 containing: Type 'number' is not assignable to type 'string'
     but it compiled with no errors — the contract is not being enforced
```

Fixtures import `janela/host` and `janela/api` through the package's own exports
map, exactly as a project does, so a broken exports map fails here as well.

## `test/unit` — the CLI's quiet decisions

`bin/janela.mjs` is build orchestration; the decisions inside it are pure and
now live in `bin/lib.mjs`, which the CLI imports and the tests call directly.
What is covered, and why each one matters:

| Under test | What a wrong answer looks like in production |
|---|---|
| name validation and repair | `janela init` accepts or rejects the wrong thing; a rejected name used to read as success in a script |
| Android application-id coercion | aapt2 rejects the package at build time — a Java package segment cannot contain a hyphen |
| iOS/Android config fallback | a project silently gets the wrong bundle id or display name |
| FFI manifest generation | **the link fails with an undefined symbol**, on one platform only |
| mobile library profile | the shells call an ABI symbol that was never exported |
| host specifier rewrite | the build resolves through `node_modules` and stops being static |
| PE subsystem patch | janela corrupts a compiler artifact, or leaves a console window behind a shipped app |

The manifest tests assert that every symbol `runtime/janela.ts` declares appears
in the manifest for all three desktop platforms. `ffiManifest` takes `platform`
and `macSdkPath` as parameters rather than reading `process.platform` and
shelling out to `xcrun`, so every branch is reachable from any host. The PE tests
drive the refusal paths with crafted buffers rather than a real binary —
`patchPeSubsystem` is pure over a `Buffer` and throws a typed `PeError`, while
the file I/O and the exit stay in the CLI.

`test/unit/cli.test.mjs` drives the real binary as a subprocess, because there
the **exit code** is the thing under test. Three cases in it were silent
failures before 0.12.0: a rejected project name, a mistyped `--targt ios` (which
built the desktop artifact and exited 0), and `janela init a b` (which created
`a` and never mentioned `b`).

## Keeping them honest

A test that cannot fail is worse than no test, so each suite was checked by
mutating the product and confirming the red:

| Mutation | Result |
|---|---|
| `NAME_RE` → `/^.+$/` | 3 failures, incl. `My App should be rejected` |
| drop `wvReply` from the manifest | 3 failures: `wvReply is not declared — the link would fail` |
| `invoke` → `Promise<any>` | the negative control fails; **every other fixture still passes** |

Worth repeating that last row: only the negative control noticed. Any suite
without one would have called a silent degradation to `any` a pass.
