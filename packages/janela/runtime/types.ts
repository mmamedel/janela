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

/**
 * One entry in the application menu.
 *
 * Every field is required rather than optional, and the entries are built with
 * `submenu`, `menuItem` and `menuSeparator` rather than written as literals.
 * That is a scriptc constraint made into a nicer API: a record whose fields are
 * all optional infers as `{ label: string | undefined, … }`, and an array
 * mixing a submenu, an item and a separator is a union that will not re-tag
 * into it ("union types must match exactly", SC2003). The helpers each return
 * the same total shape, so the array is homogeneous and the call site reads as
 * a tree.
 *
 * ```ts
 * app.setMenu([
 *   submenu("File", [
 *     menuItem("Open…", "open", "CmdOrCtrl+O"),
 *     menuSeparator(),
 *   ]),
 * ]);
 * ```
 */
export type MenuEntry = {
  label: string;
  /** Sent to `onMenu` when clicked. Empty for submenus and separators. */
  id: string;
  /**
   * A shortcut like "CmdOrCtrl+O" or "CmdOrCtrl+Shift+S". Modifiers: Cmd,
   * Ctrl, CmdOrCtrl, Alt/Option, Shift. Empty for none.
   */
  accel: string;
  separator: boolean;
  /** Children. Empty for a leaf. */
  items: MenuEntry[];
};

/** A clickable entry. `accel` is "" for no shortcut. */
export function menuItem(label: string, id: string, accel: string): MenuEntry {
  return { label: label, id: id, accel: accel, separator: false, items: [] };
}

/** A divider. */
export function menuSeparator(): MenuEntry {
  return { label: "", id: "", accel: "", separator: true, items: [] };
}

/** A submenu holding other entries. Nestable. */
export function submenu(label: string, items: MenuEntry[]): MenuEntry {
  return { label: label, id: "", accel: "", separator: false, items: items };
}
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

/**
 * One command's argument and result types, in normalised form.
 *
 * This is what the app class works with internally. A contract is *written*
 * as plain function types — see CommandSpec — and normalised to this by
 * `Norm` before it reaches the class.
 */
export interface CommandShape {
  args: unknown;
  result: unknown;
}

/** A normalised command table: name → shape. */
export type CommandShapes = Record<string, CommandShape>;

/**
 * How a command may be declared in a contract: as a plain function type
 * (preferred), or as the `{ args; result }` record of 0.5.x–0.7.x.
 *
 * ```ts
 * type AppCommands = {
 *   add: (args: { a: number; b: number }) => number;
 *   quit: () => void;                                    // no arguments
 *   legacy: { args: { name: string }; result: string };  // still accepted
 * };
 * ```
 */
export type CommandSpec = ((...args: never[]) => unknown) | CommandShape;

/** A contract's command table as written: name → spec. */
export type CommandSpecs = Record<string, CommandSpec>;

/**
 * The argument type of a declared command. A function's single parameter, or
 * a record's `args`. A command declared with no parameters takes `null` — the
 * page's `invoke(name)` sends null, and nothing is lost.
 */
export type ArgsOf<F> = F extends (...a: infer P) => unknown
  ? P extends [infer A]
    ? A
    : null
  : F extends { args: infer A }
    ? A
    : null;

/**
 * The result type of a declared command. `void` is normalised to `null`:
 * every command answers the page's promise with a value, and scriptc has no
 * conversion from a void value to the `unknown` the handler table holds.
 */
export type ResultOf<F> = F extends (...a: never[]) => infer R
  ? [R] extends [void]
    ? null
    : R
  : F extends { result: infer R }
    ? R
    : never;

/**
 * Normalise a written contract to the record form the app class indexes.
 *
 * This runs where `C` is still concrete — in the `JanelaApp<C, E>` alias, one
 * step before the class — on purpose. scriptc cannot compile a *value* whose
 * type is an unresolved conditional or a mapped type indexed by a type
 * parameter (`SC2001: values of type 'ArgsOf<C[K]>' cannot be compiled yet`),
 * so the class body only ever sees plain indexed access on a record.
 * Idempotent: normalising a record-form table returns it unchanged.
 */
export type Norm<C> = {
  [K in keyof C]: { args: ArgsOf<C[K]>; result: ResultOf<C[K]> };
};

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
 * export type AppCommands = { add: (args: { a: number; b: number }) => number };
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
