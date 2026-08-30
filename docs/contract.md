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
export type AppCommands = {
  add:  (args: { a: number; b: number }) => number;
  quit: () => void;                 // a command that takes nothing
};
export type AppEvents = { added: number };

/** The app, carrying its contract — this is what the page imports. */
export type App = JanelaApp<AppCommands, AppEvents>;
```

The contract is types and nothing else. Earlier releases (0.5.x/0.6.x) also
required `defineCommands()` / `defineEvents()` tokens and a
`{ commands, events }` wrapper; those exist only to carry type parameters, so
0.7.x names the app itself instead. The tokens remain exported and deprecated,
and `createClient` reads either shape.

```ts
// src/App.tsx
import type { App } from "../src-host/main";
const client = createClient<App>();
```

`import type` is erased before the bundler sees it, so the host module is never
pulled into the page. The built frontend bundle contains none of the host's
code — that is checked in CI-adjacent verification by grepping the bundle for
host-only strings.

## Why the app is a class

The host side reads naturally:

```ts
export function setup(app: App): void {
  app.command("add", (args) => args.a + args.b);
}
```

Getting there required one non-obvious thing: `JanelaApp` is a **class**, not
an interface. scriptc dispatches generic methods statically, so it can only
compile a call when the receiver's runtime class is provable — and an
interface, being signature-only, never is:

```
error SC1090: calls of the generic method 'command' through this receiver
(the interface declaration is signature-only and generic methods dispatch
statically, so the receiver's runtime class must be provable — bind the
receiver to a const initialized with its 'new' expression) is not supported yet
```

The message points at `new`, but the real requirement is narrower: the
receiver's **type** must be a class. A plain function parameter works, which is
exactly what `setup(app)` is. So the class never appears in application code —
you annotate, you never construct.

Two consequences worth knowing:

- **scriptc monomorphises generic classes.** `JanelaApp<A>` and `JanelaApp<B>`
  are different runtime types, and no cast bridges them (`'JanelaApp%0' values
  where 'JanelaApp%1' is expected`). The generated entry therefore *constructs*
  the app at the instantiation your `setup` asks for, reading the type
  arguments back off its signature.
- **Some shapes still don't compile**, which is why the API looks the way it
  does rather than some tidier way. A discriminated-union argument
  (`app.command({ name, handler })`) fails with `SC2009`; a factory returning a
  generic function (`const command = commandsOf(app); command("add", …)`) fails
  with `SC1090` — "results that are themselves generic functions"; and a single
  exhaustive handler map compiles for sync commands but not async ones, because
  the `resolve` callback cannot width-coerce (`SC2002`).

The deprecated `on` / `onAsync` / `emit` functions from 0.5.x are one-line
wrappers over the methods, kept so existing code keeps compiling.

## Gotchas

- **A command that takes nothing is `() => void`**, and its handler returns
  `null`. `void` is normalised to `null` because every command answers the
  page's promise with a value, and scriptc has no conversion from a void value
  to the `unknown` the handler table holds.
- **The normalisation happens in the `JanelaApp` alias, not in the class.**
  scriptc cannot compile a *value* whose type is an unresolved conditional or a
  mapped type indexed by a type parameter — `SC2001: values of type
  'ArgsOf<C[K]>' cannot be compiled yet`. Converting the written contract to
  the `{ args; result }` form one step earlier, where the table is still
  concrete, leaves the class body indexing a plain record as it always did.
- **An event payload is one value.** It may be any JSON-shaped type, including
  a tuple, but prefer an object for multi-value events: a later field does not
  break existing listeners, and named fields read better. The varargs spelling
  `app.emit("progress", 3, 10)` does not compile — instantiating a rest
  parameter from a generic indexed tuple gives `SC2011: values of type
  '[done: number, total: number]' have no static representation`, which would
  require `--dynamic` and ~620 KB of embedded engine.
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
