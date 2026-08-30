// janela's iOS runtime lane.
//
// Same public surface as runtime/janela.ts — `app.command`, `app.emit`, the
// typed contract — so a project's src-host/main.ts compiles unchanged on both.
// The CLI picks a lane by copying one of these two files in as `./janela`.
//
// What differs is who is in charge. On desktop, TypeScript owns `main` and
// calls a blocking wvRun(); scriptc's event loop is parked for the app's life,
// so this runtime carries a ticker, a timer queue and a deferred-job pool to
// get work done anyway. On iOS none of that can exist:
//
//   - scriptc builds iOS as a LIBRARY (it refuses executables for the target),
//     and library mode requires an async-free module graph — SC4005 rejects a
//     build whose graph reaches setTimeout, promises or threads. There is no
//     event loop linked into the artifact at all.
//   - UIKit owns the run loop and calls us. Each handleInvoke() runs to
//     completion and returns, so nothing needs pumping.
//
// The result is much smaller: a command registry and a dispatch function.
// Everything that needed the loop is not available on iOS *yet* — it reports
// when called rather than failing silently, and every such path goes through
// one guard so that restoring parity is a single edit. See the stubs below.

import type {
  AsyncCommandHandler,
  CommandHandler,
  CommandShapes,
  CommandSpecs,
  DialogFilter,
  FsCallback,
  Norm,
  OpenDialogOptions,
  SaveDialogOptions,
  WindowConfig,
} from "./types";

// The host-callback channel declared in the generated library profile. The
// shell registers it before jl_init(); calling a channel the host never
// registered is a defined trap (SC4025), not undefined behaviour.
declare function janelaEmit(event: string, payloadJson: string): void;

function encode(value: unknown): string {
  if (value === undefined) return "null";
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// The one place iOS says "not yet"
// ---------------------------------------------------------------------------
//
// Everything below funnels through `pending()`. Nothing else in this file
// decides what is or is not available, so the day a capability lands on iOS
// its stub becomes a real implementation and this comment shrinks.
//
// The scheduling family — commandAsync, defer, sleep — is the near-term one.
// It is absent today only because a library build links no event loop
// (SC4005), not because iOS cannot do it: UIKit schedules perfectly well, and
// routing timers through the shell (host schedules, library is re-entered when
// they fire) would give full parity. `scheduling()` marks exactly the calls
// that a shell-scheduling change replaces, so that change edits one path.
//
// FAILING LOUDLY WITHOUT KILLING THE APP: an uncaught throw in library mode
// reaches the panic sink and then ABORTS the process (SC4013). So a stub must
// never throw from setup() — registering an async command at startup would
// kill the app before its first frame. Stubs that hand back a callback report
// through it; fire-and-forget stubs log; and commandAsync registers a command
// that throws only when the page calls it, where dispatch()'s try/catch turns
// it into a rejected promise.

/** The single message every not-yet-on-iOS path reports. */
function pending(api: string, why: string): string {
  return (
    "janela: app." + api + " is not available on iOS yet — " + why + ". " +
    "Parity is planned; see docs/ios.md."
  );
}

/**
 * The scheduling family's guard — commandAsync, defer and sleep.
 *
 * These three are absent for one shared reason, and will return for one
 * shared reason. Replacing this function with a real implementation (timers
 * scheduled by the shell, the library re-entered when they fire) is the whole
 * of that change on this side.
 */
function scheduling(api: string): string {
  return pending(api, "an iOS build links no event loop of its own");
}

/**
 * A running janela app on iOS, typed by the contract it serves.
 *
 * Deliberately the same class name as the desktop lane: the generated entry
 * and a project's main.ts are compiled against whichever file the CLI copied
 * in, so both must present the same type.
 */
export class JanelaAppImpl<
  C extends CommandShapes = CommandShapes,
  E = Record<string, unknown>,
> {
  names: string[] = [];
  handlers: CommandHandler[] = [];
  html = "";

  // Kept so the shared WindowConfig shape compiles; iOS has no window to size.
  constructor(_cfg: WindowConfig) {}

  /**
   * Register a named command, callable from the page as janela.invoke(name, args).
   *
   * With a contract (`JanelaApp<App>`) the name must be one the contract
   * declares, `args` is inferred from it, and the return value is checked
   * against it. Without one, `args` is `unknown` and any name is accepted.
   */
  command<K extends keyof C & string>(
    name: K,
    handler: (args: C[K]["args"]) => C[K]["result"],
  ): void {
    this.names.push(name);
    // The cast is on the VALUE, inside a contextually-typed closure: casting
    // the function itself to another signature and calling through it fails
    // at runtime.
    this.handlers.push((args: unknown) => handler(args as C[K]["args"]));
  }

  /**
   * Fire an event into the page; the payload is delivered as a value. Under a
   * contract, the name must be declared and the payload must match its type.
   *
   * Reaches the page through the host-callback channel: the shell evaluates
   * `window.__wvEmit(...)` on the main queue.
   */
  emit<K extends keyof E & string>(event: K, payload: E[K]): void {
    janelaEmit(event, encode(payload));
  }

  /**
   * Answer one page invoke. Called by the generated entry, which the shell
   * calls through the library's C ABI.
   *
   * A command that throws is caught here and reported as a rejection rather
   * than taking the app down with it — on iOS an uncaught throw would abort
   * the process.
   */
  dispatch(cmd: string, argsJson: string): string {
    try {
      const args = JSON.parse(argsJson) as unknown;
      for (let i = 0; i < this.names.length; i++) {
        if (this.names[i] === cmd) {
          return encode({ ok: true, value: this.handlers[i](args) });
        }
      }
      return encode({ ok: false, error: "unknown command: " + cmd });
    } catch (e) {
      return encode({ ok: false, error: (e as Error).message });
    }
  }

  /** The document the shell should load. Set by the generated entry. */
  setHtml(html: string): void {
    this.html = html;
  }

  indexHtml(): string {
    return this.html;
  }

  // -------------------------------------------------------------------------
  // Not yet on iOS
  // -------------------------------------------------------------------------
  // Present so that a project written for desktop still COMPILES for iOS —
  // the typed contract and main.ts are shared source. Each reports clearly at
  // the point of use instead of doing nothing quietly, and each routes through
  // pending() / scheduling() above so there is one place to change.

  /**
   * @remarks Not on iOS yet — an iOS build links no event loop, so nothing can
   * answer later. The command is registered and rejects when invoked; parity
   * is planned.
   */
  commandAsync<K extends keyof C & string>(
    name: K,
    _handler: (
      args: C[K]["args"],
      resolve: (value: C[K]["result"]) => void,
      reject: (reason: unknown) => void,
    ) => void,
  ): void {
    // Registering must not throw — setup() runs at library init, outside any
    // try/catch, where a throw would abort the app before it draws. Instead
    // the command exists and rejects, which dispatch() contains.
    const message = scheduling("commandAsync");
    this.names.push(name);
    this.handlers.push((_args: unknown) => {
      throw new Error(message);
    });
  }

  /** @remarks Not on iOS yet; see scheduling() above. */
  defer(_fn: () => void): void {
    console.error(scheduling("defer"));
  }

  /** @remarks Not on iOS yet; see scheduling() above. */
  sleep(_ms: number, _fn: () => void): void {
    console.error(scheduling("sleep"));
  }

  /** @remarks Not on iOS yet; reports through the callback. */
  readFileAsync(_path: string, cb: FsCallback): void {
    cb(pending("readFileAsync", "file access is not wired on iOS"), "");
  }

  /** @remarks Not on iOS yet; reports through the callback. */
  writeFileAsync(_path: string, _data: string, cb: (err: string | null) => void): void {
    cb(pending("writeFileAsync", "file access is not wired on iOS"));
  }

  /** @remarks Not on iOS yet; reports through the callback. */
  openFileDialog(
    _options: OpenDialogOptions,
    cb: (paths: string[] | null, err?: string) => void,
  ): void {
    cb(null, pending("openFileDialog", "iOS needs a document picker"));
  }

  /** @remarks Not on iOS yet; reports through the callback. */
  saveFileDialog(
    _options: SaveDialogOptions,
    cb: (path: string | null, err?: string) => void,
  ): void {
    cb(null, pending("saveFileDialog", "iOS needs a document picker"));
  }

  /** @remarks No-op on iOS: an app has no window title to set. */
  setTitle(_title: string): void {
    console.error(pending("setTitle", "an iOS app has no window title"));
  }

  /** @remarks No-op on iOS: an app fills the screen. */
  setSize(_width: number, _height: number, _hint?: number): void {
    console.error(pending("setSize", "an iOS app fills the screen"));
  }

  /** @remarks No-op on iOS: an app is always fullscreen. */
  setFullscreen(_on: boolean): void {
    console.error(pending("setFullscreen", "an iOS app is always fullscreen"));
  }

  /** @remarks No-op on iOS: apps are dismissed by the user, not by code. */
  quit(): void {
    console.error(pending("quit", "iOS apps are dismissed by the user"));
  }

  /**
   * Present for source compatibility with the desktop lane; UIKit owns the run
   * loop here, so the shell shows the page rather than this.
   */
  run(html: string): number {
    this.setHtml(html);
    return 0;
  }
}

// The public host types live in ./types (shipped as `janela/host` too, so a
// user's editor can see them). Re-exported here because the compiled build
// resolves them through this module — see the specifier rewrite in the CLI.
export type {
  ArgsOf,
  AsyncCommandHandler,
  CommandHandler,
  CommandShape,
  CommandShapes,
  CommandSpec,
  CommandSpecs,
  Commands,
  Norm,
  ResultOf,
  DialogFilter,
  Events,
  FsCallback,
  OpenDialogOptions,
  SaveDialogOptions,
  WindowConfig,
} from "./types";

export { defineCommands, defineEvents } from "./types";

/**
 * A running janela app, typed by the contract it serves. See the desktop lane
 * for the full explanation; the alias exists so a contract may be written as
 * plain function types.
 */
export type JanelaApp<
  C extends CommandSpecs = CommandShapes,
  E = Record<string, unknown>,
> = JanelaAppImpl<Norm<C>, E>;

export function createApp<
  C extends CommandShapes = CommandShapes,
  E = Record<string, unknown>,
>(cfg: WindowConfig): JanelaAppImpl<C, E> {
  return new JanelaAppImpl<C, E>(cfg);
}

// ---------------------------------------------------------------------------
// Deprecated standalone registrars (0.5.x)
// ---------------------------------------------------------------------------

/** @deprecated Use `app.command(name, handler)` on a contract-typed app. */
export function on<M extends CommandShapes, K extends keyof M & string>(
  app: JanelaAppImpl,
  _commands: unknown,
  name: K,
  handler: (args: M[K]["args"]) => M[K]["result"],
): void {
  app.command(name, (args: unknown) => handler(args as M[K]["args"]));
}

/** @deprecated Use `app.commandAsync(name, handler)` on a contract-typed app. */
export function onAsync<M extends CommandShapes, K extends keyof M & string>(
  app: JanelaAppImpl,
  _commands: unknown,
  name: K,
  handler: (
    args: M[K]["args"],
    resolve: (value: M[K]["result"]) => void,
    reject: (reason: unknown) => void,
  ) => void,
): void {
  app.commandAsync(
    name,
    (args: unknown, resolve: (v: unknown) => void, reject: (r: unknown) => void) => {
      handler(args as M[K]["args"], (value: M[K]["result"]) => resolve(value), reject);
    },
  );
}

/** @deprecated Use `app.emit(event, payload)` on a contract-typed app. */
export function emit<E, K extends keyof E & string>(
  app: JanelaAppImpl,
  _events: unknown,
  name: K,
  payload: E[K],
): void {
  app.emit(name, payload as unknown);
}
