# The typed IPC contract

janela apps are TypeScript on both sides of the window. That makes something
possible that a mixed-language framework cannot do without a code generator:
the frontend can `import type` the host's own declarations, so command names,
argument shapes, results and event payloads are all checked by the compiler
against a single source of truth.

Tauri, for comparison, has a Rust host and a JavaScript page. Types cannot
cross that boundary on their own, so `invoke<T>(...)` there is an assertion you
write by hand — rename a command or change a field and the frontend still
compiles, then fails at runtime. Closing that gap needs a generator
(tauri-specta, ts-rs) run as a build step. Here it needs nothing: the two sides
already speak the same language.

## Shape

```ts
// src-host/main.ts
export const commands = defineCommands<{
  add: { args: { a: number; b: number }; result: number };
}>();
export const events = defineEvents<{ added: number }>();
export type App = { commands: typeof commands; events: typeof events };
```

```ts
// src/App.tsx
import type { App } from "../src-host/main";
const client = createClient<App>();
```

`import type` is erased before the bundler sees it, so the host module is never
pulled into the page. The built frontend bundle contains none of the host's
code — that is checked in CI-adjacent verification by grepping the bundle for
host-only strings.

## Why the registrars take the app and the contract

The host side reads a little unusually:

```ts
on(app, commands, "add", (args) => args.a + args.b);
```

rather than the more obvious `commands.on(app, "add", …)` or a bound registrar
object. That is a scriptc constraint, not a preference. scriptc cannot dispatch
a **generic method** through an interface-typed receiver:

```
error SC1090: calls of the generic method 'onAsync' through this receiver
(the interface declaration is signature-only and generic methods dispatch
statically, so the receiver's runtime class must be provable) is not
supported yet
```

Standalone generic functions compile fine, so the registrars are standalone
functions that take the contract as a value — the value is empty, and exists
only so inference has something to read.

A second constraint shaped the handler wrapper. Casting a *function* to a
different signature and calling it through the cast fails at runtime
(scriptc's `as` inserts a checked conversion), and coercing a record of
differently-typed handlers into `Record<string, T>` is rejected outright. What
does work is wrapping in a contextually-typed closure and casting the *value*:

```ts
app.command(name, (args: unknown) => handler(args as M[K]["args"]));
```

which is the same shape hand-written janela handlers already used.

## Gotchas

- **Use `args: null`, not `args: undefined`, for a command that takes nothing.**
  An `undefined` argument type lowers to a zero-parameter function, and the
  registration then fails to compile with a union-mismatch or an arity error.
- **Types erase at runtime.** Payloads cross as JSON; nothing validates a
  malformed one. The contract buys compile-time safety only.
- **The contract is optional.** `app.command(name, handler)` and the untyped
  `invoke` / `listen` still work, and the `vanilla` template still uses the
  injected global with no build step at all.

## Events and unsubscribing

`listen()` and `client.on()` return a disposer:

```ts
const off = client.on("added", (v) => console.log(v));
off();   // no further deliveries
```

The injected global's `janela.listen` returns one too. Hosts older than 0.5.0
returned nothing, so `janela/api` falls back to splicing the listener array
itself rather than handing back an undefined disposer.
