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
declare function hostSchedule(id: number, ms: number): void;
declare function hostSettle(pendingId: number, envelopeJson: string): void;
declare function hostReadFile(jobId: number, path: string): void;
declare function hostWriteFile(jobId: number, path: string, data: string): void;
declare function hostOpenDialog(jobId: number, optionsJson: string): void;

// One job table serves reads and writes; these sentinels say which callback of
// the pair is the real one. Identity comparison is the whole trick, so they
// must be module-level singletons rather than fresh closures.
const nullRead: FsCallback = (_e: string | null, _t: string) => {};
const nullWrite: (err: string | null) => void = (_e: string | null) => {};

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
// The scheduling family — commandAsync, defer, sleep — and file I/O now work
// exactly as they do on desktop: TS never holds a timer or a file handle, it
// parks work with the shell under an id and is re-entered when the shell has
// an answer. A library build still links no event loop (SC4005); that is why
// the design routes through the shell rather than a limitation of iOS.
//
// `openFileDialog` now works too: the shell presents the platform picker and
// copies the chosen file into the app's container, so the path it hands back
// is one `readFileAsync` can open.
//
// What remains behind pending(): `saveFileDialog`, which is not a missing
// implementation but an unmade API decision (see its doc comment — mobile
// wants an export-shaped call, not a path to write to), and window control,
// which is permanently meaningless on a phone rather than unfinished.
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
// ---- menus ---------------------------------------------------------------
//
// A mirror of the desktop lane's menu builders, so a project's src-host can
// declare a menu and still compile for a phone. Nothing renders here — iOS
// has no menu bar — but the objects are real, so handlers, `setEnabled` and
// the rest are ordinary no-ops rather than missing symbols.
//
// Duplicated rather than shared because the CLI copies ONE of these two files
// in as `./janela`: a shared module would have to inject the FFI the desktop
// setters call, which is more machinery than the forty lines it would save.

/** Submenus and separators have nothing to run. */
function menuNoop(): void {}

/** An entry in the application menu. See the desktop lane for what it does. */
export class MenuItem {
  label: string;
  accel: string;
  separator: boolean;
  items: MenuItem[];
  onClick: () => void;
  enabled = true;
  checkable = false;
  checked = false;
  tag = -1;
  ownerHandle = -1;

  constructor(
    label: string,
    accel: string,
    separator: boolean,
    items: MenuItem[],
    onClick: () => void,
  ) {
    this.label = label;
    this.accel = accel;
    this.separator = separator;
    this.items = items;
    this.onClick = onClick;
  }

  /** Records the state. False: there is no live menu here to change. */
  setEnabled(on: boolean): boolean {
    this.enabled = on;
    return false;
  }

  /** Records the state. False: there is no live menu here to change. */
  setLabel(label: string): boolean {
    this.label = label;
    return false;
  }
}

/** An item that can carry a tick. */
export class CheckMenuItem extends MenuItem {
  constructor(label: string, accel: string, onClick: () => void) {
    super(label, accel, false, [], onClick);
    this.checkable = true;
  }

  /** Records the state. False: there is no live menu here to change. */
  setChecked(on: boolean): boolean {
    this.checked = on;
    return false;
  }
}

/** A clickable entry. `accel` is "" for no shortcut. */
export function menuItem(label: string, accel: string, onClick: () => void): MenuItem {
  return new MenuItem(label, accel, false, [], onClick);
}

/** A clickable entry that carries a tick. */
export function menuCheckItem(label: string, accel: string, onClick: () => void): CheckMenuItem {
  return new CheckMenuItem(label, accel, onClick);
}

/** A divider. */
export function menuSeparator(): MenuItem {
  return new MenuItem("", "", true, [], menuNoop);
}

/** A submenu holding other entries. Nestable. */
export function submenu(label: string, items: MenuItem[]): MenuItem {
  return new MenuItem(label, "", false, items, menuNoop);
}

/**
 * The platform's own actions.
 *
 * Every one returns false here. On desktop these are AppKit selectors, Win32
 * messages and WebKitGTK editing commands; a phone has none of them, and the
 * editing gestures it does have belong to UIKit and need no menu to reach.
 */
export const predefined = {
  about: (): boolean => false,
  hide: (): boolean => false,
  hideOthers: (): boolean => false,
  showAll: (): boolean => false,
  quit: (): boolean => false,
  close: (): boolean => false,

  undo: (): boolean => false,
  redo: (): boolean => false,
  cut: (): boolean => false,
  copy: (): boolean => false,
  paste: (): boolean => false,
  selectAll: (): boolean => false,

  minimize: (): boolean => false,
  zoom: (): boolean => false,
  fullscreen: (): boolean => false,
};

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

  // ---- scheduling ----------------------------------------------------------
  // Identical in shape to the desktop lane, and for a stronger reason: an iOS
  // library links no event loop at all (SC4005), so TS could not hold a timer
  // even if it wanted to. It parks a continuation under an id, asks the shell
  // to schedule it, and the shell re-enters onTimer(id) on the main queue when
  // it comes due. Nothing here polls.
  contIds: number[] = [];
  contFns: (() => void)[] = [];
  nextCont = 1;

  // An invoke whose answer is not ready when dispatch() returns. The shell
  // holds the page's reply under this id and settles it when hostSettle()
  // arrives. Mirrors the desktop shim's wv_defer/wv_resolve pair.
  pendingIds: number[] = [];
  nextPending = 1;
  deferred = -1; // set by an async command during its own dispatch()

  // In-flight file jobs: the shell does the blocking I/O on its own queue and
  // re-enters onFsDone() with the result.
  jobIds: number[] = [];
  jobCbs: FsCallback[] = [];
  jobWriteCbs: ((err: string | null) => void)[] = [];
  nextJob = 1;

  // In-flight file dialogs. Separate from the file jobs above: a picker is
  // presented by the shell and answered when the user is done, which may be
  // never. Kept in its own table so a dialog result can never be mistaken for
  // a file-I/O result.
  dialogIds: number[] = [];
  dialogCbs: ((paths: string[] | null, err?: string) => void)[] = [];
  nextDialog = 1;

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
          this.deferred = -1;
          const value = this.handlers[i](args);
          // An async command parked its answer during the call above. Tell the
          // shell to hold the page's reply under that id instead of settling
          // now; hostSettle() answers it later.
          if (this.deferred >= 0) {
            const held = this.deferred;
            this.deferred = -1;
            return encode({ pending: held });
          }
          return encode({ ok: true, value });
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
  // pending() above so there is one place to change.

  /**
   * An async command: answer later, without freezing the window.
   *
   * The handler runs during dispatch() but need not produce a value. It parks
   * a pending id; dispatch() returns that id to the shell, which holds the
   * page's promise until resolve/reject settles it. Same contract as desktop.
   */
  commandAsync<K extends keyof C & string>(
    name: K,
    handler: (
      args: C[K]["args"],
      resolve: (value: C[K]["result"]) => void,
      reject: (reason: unknown) => void,
    ) => void,
  ): void {
    this.names.push(name);
    this.handlers.push((args: unknown) => {
      const id = this.nextPending;
      this.nextPending = id + 1;
      this.pendingIds.push(id);
      // dispatch() reads this immediately after the handler returns.
      this.deferred = id;
      handler(
        args as C[K]["args"],
        (value: C[K]["result"]) => {
          this.settle(id, encode({ ok: true, value: value }));
        },
        (reason: unknown) => {
          this.settle(id, encode({ ok: false, error: String(reason) }));
        },
      );
      return null;
    });
  }

  /** Settle a held reply once, ignoring a second resolve/reject. */
  settle(id: number, envelope: string): void {
    for (let i = 0; i < this.pendingIds.length; i++) {
      if (this.pendingIds[i] === id) {
        this.pendingIds.splice(i, 1);
        hostSettle(id, envelope);
        return;
      }
    }
  }

  /**
   * Park `fn` with the shell and ask to be called back in `ms`.
   *
   * The id is the whole protocol: TS keeps the closure, the shell keeps the
   * clock. Identical to the desktop lane.
   */
  schedule(ms: number, fn: () => void): void {
    const id = this.nextCont;
    this.nextCont = id + 1;
    this.contIds.push(id);
    this.contFns.push(fn);
    const delay = ms > 0 ? ms : 0;
    hostSchedule(id, delay);
  }

  /** Run fn on the next turn of the host loop — no timer involved. */
  defer(fn: () => void): void {
    this.schedule(0, fn);
  }

  /** Run fn after roughly `ms`, without blocking the window meanwhile. */
  sleep(ms: number, fn: () => void): void {
    this.schedule(ms, fn);
  }

  /**
   * Called by the shell on the main queue when a continuation comes due.
   *
   * This always lands at the top of a fresh turn with no TS frame beneath it,
   * because the shell posts through its own queue rather than calling back
   * from inside a channel handler (upstream #263: a breach silently appears
   * to work, so it has to hold by construction).
   */
  onTimer(id: number): void {
    for (let i = 0; i < this.contIds.length; i++) {
      if (this.contIds[i] === id) {
        const fn = this.contFns[i];
        // Unregister BEFORE running: a continuation that schedules another one
        // must not disturb the entry being removed.
        this.contIds.splice(i, 1);
        this.contFns.splice(i, 1);
        fn();
        return;
      }
    }
  }

  /** Read a file without blocking the UI; the shell does the I/O off-queue. */
  readFileAsync(path: string, cb: FsCallback): void {
    const id = this.nextJob;
    this.nextJob = id + 1;
    this.jobIds.push(id);
    this.jobCbs.push(cb);
    this.jobWriteCbs.push(nullWrite);
    hostReadFile(id, path);
  }

  /** Write a file without blocking the UI; the shell does the I/O off-queue. */
  writeFileAsync(path: string, data: string, cb: (err: string | null) => void): void {
    const id = this.nextJob;
    this.nextJob = id + 1;
    this.jobIds.push(id);
    this.jobCbs.push(nullRead);
    this.jobWriteCbs.push(cb);
    hostWriteFile(id, path, data);
  }

  /**
   * Called by the shell on the main queue when a file job finishes. `payload`
   * carries the contents on a read, or the error message when `ok` is false.
   */
  onFsDone(id: number, ok: boolean, payload: string): void {
    for (let i = 0; i < this.jobIds.length; i++) {
      if (this.jobIds[i] === id) {
        const readCb = this.jobCbs[i];
        const writeCb = this.jobWriteCbs[i];
        this.jobIds.splice(i, 1);
        this.jobCbs.splice(i, 1);
        this.jobWriteCbs.splice(i, 1);
        if (readCb !== nullRead) {
          if (ok) readCb(null, payload);
          else readCb(payload, "");
        } else {
          writeCb(ok ? null : payload);
        }
        return;
      }
    }
  }

  /**
   * Present the platform's document picker.
   *
   * The paths handed back are **copies inside the app's own storage**, not the
   * locations the user picked. Neither platform gives an app a durable path to
   * a file outside its container: iOS returns a security-scoped URL that is
   * readable only while its access is held and does not survive a relaunch
   * without a bookmark, and Android returns a `content://` URI that is not a
   * path at all. Copying is what makes the result something `readFileAsync`
   * can open, and keeps this API identical to desktop. Nothing tracks the
   * original afterwards, so a later read sees the file as it was when picked.
   */
  openFileDialog(
    options: OpenDialogOptions,
    cb: (paths: string[] | null, err?: string) => void,
  ): void {
    const id = this.nextDialog;
    this.nextDialog = id + 1;
    this.dialogIds.push(id);
    this.dialogCbs.push(cb);
    hostOpenDialog(id, JSON.stringify(options));
  }

  /**
   * Called by the shell on the main queue when a picker closes.
   *
   * `ok` false carries an error message in `payload`. `ok` true carries a JSON
   * array of paths — empty when the user cancelled, which answers `null` to
   * match desktop.
   */
  onDialogDone(id: number, ok: boolean, payload: string): void {
    for (let i = 0; i < this.dialogIds.length; i++) {
      if (this.dialogIds[i] === id) {
        const cb = this.dialogCbs[i];
        this.dialogIds.splice(i, 1);
        this.dialogCbs.splice(i, 1);
        if (!ok) {
          cb(null, payload);
          return;
        }
        const paths = JSON.parse(payload) as string[];
        // Cancel is not an error: desktop answers null, so this does too.
        if (paths.length < 1) cb(null);
        else cb(paths);
        return;
      }
    }
  }

  /**
   * @remarks Not on mobile; reports through the callback.
   *
   * Deliberately still absent while `openFileDialog` works, because the two
   * are not symmetrical here. Desktop's "save" means *tell me where to write*,
   * and neither mobile platform offers that: iOS's `forExporting:` picker
   * requires the file to already exist before it opens, and Android's
   * `ACTION_CREATE_DOCUMENT` hands back a URI to write into rather than a
   * path. Both want an export-shaped call — "here is a file, put it
   * somewhere" — which is a different operation, not a different spelling of
   * this one. Implementing it as `saveFileDialog` would give the same method
   * two meanings across platforms, so it waits for an API decision.
   */
  saveFileDialog(
    _options: SaveDialogOptions,
    cb: (path: string | null, err?: string) => void,
  ): void {
    cb(
      null,
      pending(
        "saveFileDialog",
        "a phone has no 'choose a path to write' picker; iOS and Android both " +
          "want an export-shaped call, which is a different operation",
      ),
    );
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
   * @remarks Returns false on iOS: a phone has no menu bar to put this in.
   *
   * Present so a project's `src-host/main.ts` compiles on both lanes — the
   * whole reason this file mirrors the desktop one. The items are still built,
   * so their handlers and any later `setEnabled` are ordinary no-ops rather
   * than crashes; what is absent is somewhere to render them.
   */
  setMenu(_entries: MenuItem[]): boolean {
    console.error(pending("setMenu", "a phone has no menu bar"));
    return false;
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
