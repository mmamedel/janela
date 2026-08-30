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
// The contract is carried by the app's own type — `JanelaApp<Commands, Events>`
// — so the tables below are types and nothing more. The `Commands`/`Events`
// tokens and their `define*` constructors are the 0.5.x/0.6.x shape, kept so
// projects written against it still compile.

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
 * @deprecated The contract needs no runtime token. Declare the tables as
 * types and name the app itself:
 *
 * ```ts
 * export type AppCommands = { add: { args: { a: number; b: number }; result: number } };
 * export type AppEvents = { added: number };
 * export type App = JanelaApp<AppCommands, AppEvents>;
 * export function setup(app: App): void { … }
 * ```
 */
export function defineCommands<M extends CommandShapes>(): Commands<M> {
  return {};
}

/**
 * Declare the events a host emits: `defineEvents<{ added: number }>()`.
 *
 * @deprecated Pass the event table to `JanelaApp` instead — see defineCommands.
 */
export function defineEvents<E>(): Events<E> {
  return {};
}
