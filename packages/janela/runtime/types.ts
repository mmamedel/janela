/**
 * Public host-side types for a janela app — the shapes `src-host/main.ts`
 * works with.
 *
 * This file is the single definition of those types. It is both:
 *   - what `import type { JanelaApp } from "janela/host"` resolves to in an
 *     editor, via the package's exports map; and
 *   - re-exported by runtime/janela.ts, which is what the compiled build
 *     actually links against (the CLI copies both files into .janela/build/).
 *
 * Mostly declarations; the typed-contract helpers at the bottom are the only
 * runtime code, and they are deliberately trivial.
 */

// Handlers take the invoked arguments as a value and return a value; the
// runtime owns JSON at the boundary. `args` is whatever the page passed to
// janela.invoke(name, args) — cast it to the shape you expect. The return
// value is what the page's promise resolves with.
//
// Throwing is not supported by scriptc across the FFI boundary. Use
// commandAsync's `reject` to fail a call, or return an error value.
export type CommandHandler = (args: unknown) => unknown;

/**
 * An async command: return immediately, answer later. `resolve`/`reject` take
 * a value and settle the page's `await janela.invoke(...)` promise whenever
 * they are called — from a later defer()/sleep() turn, or from another
 * command. The window stays responsive for as long as the call is pending.
 */
export type AsyncCommandHandler = (
  args: unknown,
  resolve: (value: unknown) => void,
  reject: (reason: unknown) => void,
) => void;

/**
 * Completion of an async file operation. `err` is null on success; on failure
 * it carries a Node-shaped message ("ENOENT: no such file or directory, open
 * '/x'") and `text` is empty. Errors arrive as values, never as throws —
 * scriptc cannot propagate an exception across the FFI boundary.
 */
export type FsCallback = (err: string | null, text: string) => void;

/** A named group of extensions offered in a dialog's file-type popup. */
export interface DialogFilter {
  name: string;
  /** Bare extensions, no dot and no glob: ["png", "jpg"]. */
  extensions: string[];
}

export interface OpenDialogOptions {
  title?: string;
  /** Directory the dialog opens in. */
  defaultPath?: string;
  /** Allow picking more than one entry. */
  multiple?: boolean;
  /** Pick directories instead of files. Not supported on Windows. */
  directory?: boolean;
  filters?: DialogFilter[];
}

export interface SaveDialogOptions {
  title?: string;
  defaultPath?: string;
  /** Filename pre-filled in the name field. */
  defaultName?: string;
  filters?: DialogFilter[];
}

export interface WindowConfig {
  title: string;
  width: number;
  height: number;
}

export interface JanelaApp {
  handle: number;
  names: string[];
  handlers: CommandHandler[];
  /** Register a named command, callable from the page as janela.invoke(name, args). */
  command: (name: string, h: CommandHandler) => void;
  /** Register a command that answers later; see AsyncCommandHandler. */
  commandAsync: (name: string, h: AsyncCommandHandler) => void;
  /** Run fn on the next turn of the host loop — the way to slice long work. */
  defer: (fn: () => void) => void;
  /** Run fn after at least ms. The host loop's timer; scriptc's setTimeout
   *  cannot fire while the window is open (its loop is parked inside run()). */
  sleep: (ms: number, fn: () => void) => void;
  /**
   * Read a file without blocking the window. The syscall runs on a shim
   * worker thread; the callback lands on the UI thread on a later turn.
   * Prefer this over node:fs readFileSync inside a command — that one blocks
   * the loop, and with it the whole window.
   */
  readFileAsync: (path: string, cb: FsCallback) => void;
  /** Write a file without blocking the window; cb(null) on success. */
  writeFileAsync: (
    path: string,
    data: string,
    cb: (err: string | null) => void,
  ) => void;
  /**
   * Show the native "open" dialog. `cb` gets the chosen paths, or null if the
   * user cancelled. The modal runs on a later turn of the UI thread, so
   * calling this from inside a command does not block that command's reply —
   * pair it with commandAsync when the page is waiting for the result.
   */
  openFileDialog: (
    options: OpenDialogOptions,
    cb: (paths: string[] | null, err?: string) => void,
  ) => void;
  /** Show the native "save" dialog; cb gets the path, or null on cancel. */
  saveFileDialog: (
    options: SaveDialogOptions,
    cb: (path: string | null, err?: string) => void,
  ) => void;
  /** Change the window title at any time, not just at startup. */
  setTitle: (title: string) => void;
  /**
   * Resize the window. `hint` is webview's sizing hint: 0 none, 1 minimum,
   * 2 maximum, 3 fixed.
   */
  setSize: (width: number, height: number, hint?: number) => void;
  /** Enter or leave fullscreen. */
  setFullscreen: (on: boolean) => void;
  /** Fire an event into the page; the payload is delivered as a value. */
  emit: (event: string, payload: unknown) => void;
  /** Close the window and make run() return. */
  quit: () => void;
  /** Show the page and block until the window closes. Returns the run status. */
  run: (html: string) => number;
}

// ---------------------------------------------------------------------------
// Typed IPC contract
// ---------------------------------------------------------------------------
//
// The contract is a TYPE the host declares and the frontend imports with
// `import type`. Because both sides are TypeScript, no code generation is
// involved and nothing can drift: the frontend checks against the host's own
// declarations, and the import is erased, so no host code reaches the bundle.
//
// Payloads still cross as JSON, so these types are compile-time only. Nothing
// validates a malformed payload at runtime.
//
// SHAPE NOTE: the registrars below are standalone generic FUNCTIONS taking the
// contract as a value, rather than methods on a returned registrar object.
// That is not a style choice — scriptc cannot dispatch a generic method
// through an interface-typed receiver (SC1090), so `commands.on(...)` does not
// compile in a host build, while `on(app, commands, ...)` does.

/** One command's argument and result types. */
export interface CommandShape {
  args: unknown;
  result: unknown;
}

/** A contract's command table: name → shape. */
export type CommandShapes = Record<string, CommandShape>;

/**
 * A declared command contract. Carries `M` at the type level only — the value
 * is empty, and exists so that inference has something to read at a call site.
 */
export interface Commands<M extends CommandShapes> {
  __commands?: M;
}

/** A declared event contract: event name → payload type. */
export interface Events<E> {
  __events?: E;
}

/**
 * Declare the commands a host exposes.
 *
 * ```ts
 * export const commands = defineCommands<{
 *   add: { args: { a: number; b: number }; result: number };
 * }>();
 * ```
 */
export function defineCommands<M extends CommandShapes>(): Commands<M> {
  return {};
}

/** Declare the events a host emits: `defineEvents<{ added: number }>()`. */
export function defineEvents<E>(): Events<E> {
  return {};
}

/**
 * Register a command against the contract. `args` is inferred from the
 * contract, and the return type is checked against it, so the handler is
 * written once with no casts.
 *
 * ```ts
 * on(app, commands, "add", (args) => args.a + args.b);
 * ```
 */
export function on<M extends CommandShapes, K extends keyof M & string>(
  app: JanelaApp,
  _commands: Commands<M>,
  name: K,
  handler: (args: M[K]["args"]) => M[K]["result"],
): void {
  app.command(name, (args: unknown) => handler(args as M[K]["args"]));
}

/**
 * Register a command that answers on a later turn. `resolve` takes the
 * contract's result type; see AsyncCommandHandler for the timing rules.
 */
export function onAsync<M extends CommandShapes, K extends keyof M & string>(
  app: JanelaApp,
  _commands: Commands<M>,
  name: K,
  handler: (
    args: M[K]["args"],
    resolve: (value: M[K]["result"]) => void,
    reject: (reason: unknown) => void,
  ) => void,
): void {
  app.commandAsync(
    name,
    (args: unknown, resolve: (value: unknown) => void, reject: (reason: unknown) => void) => {
      handler(
        args as M[K]["args"],
        (value: M[K]["result"]) => resolve(value),
        reject,
      );
    },
  );
}

/**
 * Emit a declared event. The name must exist in the contract and the payload
 * must match its type.
 *
 * ```ts
 * emit(app, events, "added", 42);
 * ```
 */
export function emit<E, K extends keyof E & string>(
  app: JanelaApp,
  _events: Events<E>,
  name: K,
  payload: E[K],
): void {
  app.emit(name, payload);
}
