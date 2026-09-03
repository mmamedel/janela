/**
 * The janela frontend API.
 *
 * Values cross the boundary as values — janela owns the JSON at the edge — so
 * the generic parameter is what the host command returns, not a string to
 * parse.
 */

import type { JanelaAppImpl } from "../runtime/janela";
import type { CommandShapes, Commands, Events } from "../runtime/types";

/** Removes a subscription created by `listen` / `client.on`. */
export type Unlisten = () => void;

/** The bridge janela injects as `window.janela` before each document loads. */
export interface JanelaBridge {
  invoke<T = unknown>(cmd: string, args?: unknown): Promise<T>;
  listen<T = unknown>(event: string, cb: (payload: T) => void): Unlisten;
}

/**
 * Call a command the host registered with `app.command` / `app.commandAsync`.
 *
 * ```ts
 * const sum = await invoke<number>("add", { a: 2, b: 40 });
 * ```
 *
 * The generic is an assertion, not a check — prefer `createClient` when the
 * host declares a contract, which verifies the name, the arguments and the
 * result against the host's own types.
 *
 * Rejects if the command is unknown, if the handler rejected, or if the page
 * is not running inside a janela window.
 */
export declare function invoke<T = unknown>(cmd: string, args?: unknown): Promise<T>;

/**
 * Subscribe to an event the host sends with `app.emit`. Returns a disposer.
 *
 * ```ts
 * const off = listen<number>("added", (sum) => console.log(sum));
 * off();
 * ```
 */
export declare function listen<T = unknown>(
  event: string,
  cb: (payload: T) => void,
): Unlisten;

// ---------------------------------------------------------------------------
// Typed contract
// ---------------------------------------------------------------------------

/**
 * Anything shaped like a host contract module's exported `App` type.
 *
 * @deprecated The `{ commands, events }` wrapper of 0.5.x/0.6.x. Export
 * `type App = JanelaApp<AppCommands, AppEvents>` instead.
 */
export interface Contract {
  commands: Commands<CommandShapes>;
  events: Events<unknown>;
}

/**
 * The command table declared by a contract.
 *
 * Reads the contract off the app type — what a host's `App` is from 0.7.0 —
 * and falls back to the 0.5.x/0.6.x `{ commands, events }` wrapper, so a
 * project written against either shape keeps checking.
 *
 * The inference targets the class rather than the `JanelaApp` alias: the
 * alias applies `Norm<C>`, which cannot be inferred backwards, and the
 * normalised table is what indexing wants in any case.
 */
export type CommandsOf<A> = A extends JanelaAppImpl<infer M, infer _E>
  ? M
  : A extends { commands: Commands<infer M> }
    ? M
    : never;

/** The event table declared by a contract; see CommandsOf for the two shapes. */
export type EventsOf<A> = A extends JanelaAppImpl<infer _M, infer E>
  ? E
  : A extends { events: Events<infer E> }
    ? E
    : never;

/**
 * A client bound to a host contract: command names, argument shapes, result
 * types and event payloads are all checked against the host's declarations.
 */
export interface JanelaClient<A> {
  /**
   * Call a declared command. Unknown names and wrong argument shapes are
   * compile errors, and the result type comes from the contract.
   *
   * A command declared to take nothing — `quit: () => void` — normalises to
   * `args: null`, and for those the argument is omitted rather than passed as
   * an explicit `null`. That is what the rest-tuple is for: it makes the
   * parameter optional for exactly those commands, and required with the
   * declared shape for every other one. The bracketed `[X] extends [null]`
   * form is deliberate — a bare `null extends X` would also match a command
   * whose arguments are legitimately nullable.
   */
  invoke<K extends keyof CommandsOf<A> & string>(
    name: K,
    ...args: [CommandsOf<A>[K]["args"]] extends [null]
      ? [args?: null]
      : [args: CommandsOf<A>[K]["args"]]
  ): Promise<CommandsOf<A>[K]["result"]>;
  /**
   * Subscribe to a declared event; the payload type is inferred. Returns a
   * disposer that removes the subscription.
   */
  on<K extends keyof EventsOf<A> & string>(
    event: K,
    cb: (payload: EventsOf<A>[K]) => void,
  ): Unlisten;
}

/**
 * Build a client checked against a host's contract.
 *
 * ```ts
 * import type { App } from "../src-host/main";   // App = JanelaApp<Cmds, Evts>
 * const client = createClient<App>();
 * const sum = await client.invoke("add", { a: 2, b: 40 });   // number
 * const off = client.on("added", (v) => console.log(v));      // v: number
 * ```
 *
 * `import type` is erased, so no host code is bundled into the page — the
 * contract is a type edge and nothing else. Payloads still cross as JSON, so
 * this is compile-time safety; nothing is validated at runtime.
 */
export declare function createClient<A>(): JanelaClient<A>;
