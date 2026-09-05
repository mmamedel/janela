// janela.ts — the janela runtime, compiled into the app by scriptc.
//
// The Tauri-shaped surface: one `__invoke` binding carries every command as a
// (name, argsJson) envelope, dispatched to handlers registered on the app
// object. Handlers see decoded values — the runtime owns JSON at the boundary.
// Backend→frontend events ride wv_eval into the injected bootstrap.

declare function wvCreate(debug: number): number;
declare function wvSetTitle(h: number, title: string): number;
declare function wvSetSize(h: number, w: number, ht: number, hint: number): number;
declare function wvSetHtml(h: number, html: string): number;
declare function wvInit(h: number, js: string): number;
declare function wvEval(h: number, js: string): number;
declare function wvBind(h: number, name: string): number;
declare function wvReply(h: number, body: string): number;
declare function wvOnInvoke(h: number, cb: (req: string) => number): number;
declare function wvOnTimer(h: number, cb: (id: number) => void): number;
declare function wvRun(h: number): number;
declare function wvTerminate(h: number): number;
declare function wvDefer(h: number): number;
declare function wvResolve(h: number, id: number, status: number): number;
declare function wvSchedule(h: number, id: number, ms: number): number;
declare function wvFsRead(h: number, path: string): number;
declare function wvFsWrite(h: number, path: string, data: string): number;
declare function wvJobStatus(h: number, id: number): number;
declare function wvJobSize(h: number, id: number): number;
declare function wvJobTakeAt(
  h: number,
  id: number,
  offset: number,
  maxBytes: number,
  sink: (text: string) => void,
): number;
declare function wvJobFree(h: number, id: number): number;
declare function wvDialog(
  h: number,
  kind: number,
  flags: number,
  title: string,
  defaultPath: string,
  defaultName: string,
  filters: string,
): number;
declare function wvSetFullscreen(h: number, on: number): number;
declare function wvSetMenu(h: number, spec: string): number;
declare function wvOnMenu(h: number, cb: (tag: number) => number): number;
declare function wvPerformAction(action: string): number;
declare function wvMenuSetEnabled(h: number, tag: number, on: number): number;
declare function wvMenuSetChecked(h: number, tag: number, on: number): number;
declare function wvMenuSetLabel(h: number, tag: number, label: string): number;

const JOB_PENDING = 0;
const JOB_OK = 1;

const DLG_OPEN = 0;
const DLG_SAVE = 1;
const DLG_MULTIPLE = 1;
const DLG_DIRECTORY = 2;

// Injected into every page before it loads (webview_init).
const BOOTSTRAP =
  "window.__wvListeners = {};" +
  "window.janela = {" +
  "  invoke: function (cmd, args) {" +
  "    return window.__invoke(cmd, JSON.stringify(args === undefined ? null : args));" +
  "  }," +
  "  listen: function (event, cb) {" +
  "    if (!window.__wvListeners[event]) window.__wvListeners[event] = [];" +
  "    window.__wvListeners[event].push(cb);" +
  "    return function () {" +
  "      var a = window.__wvListeners[event] || [];" +
  "      var i = a.indexOf(cb);" +
  "      if (i >= 0) a.splice(i, 1);" +
  "    };" +
  "  }," +
  "};" +
  "window.__wvEmit = function (event, payload) {" +
  "  var cbs = window.__wvListeners[event] || [];" +
  "  for (var i = 0; i < cbs.length; i++) cbs[i](payload);" +
  "};";

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

// The typed-contract helpers are values, so they are re-exported as values.
// A project's `import { defineCommands } from "janela/host"` is rewritten to
// this module by the CLI before scriptc sees it.
export { defineCommands, defineEvents } from "./types";

import type {
  AsyncCommandHandler,
  CommandHandler,
  CommandShapes,
  CommandSpecs,
  Commands,
  Norm,
  DialogFilter,
  Events,
  FsCallback,
  OpenDialogOptions,
  SaveDialogOptions,
  WindowConfig,
} from "./types";

// JSON.stringify yields undefined for undefined; the wire always needs a
// value, and a command that returns nothing should read as null in the page.
function encode(value: unknown): string {
  if (value === undefined) return "null";
  return JSON.stringify(value);
}


// Filters cross as "Name|ext,ext|Name|ext" - the shim needs no JSON parser
// for what is always a short, flat list.
function encodeFilters(filters: DialogFilter[] | undefined): string {
  if (filters === undefined || filters.length === 0) return "";
  const parts: string[] = [];
  for (let i = 0; i < filters.length; i++) {
    parts.push(filters[i].name);
    parts.push(filters[i].extensions.join(","));
  }
  return parts.join("|");
}

// Loop tuning. The drain budget is wall-clock rather than a byte count on
// purpose: a fixed chunk size fixes the WORST turn but also caps throughput
// (128 KB per 8 ms tick would cap reads at ~16 MB/s), whereas a time budget
// spends whatever the machine can do in the time available.
const DRAIN_BUDGET_MS = 4; // = a quarter of a 60fps frame
const DRAIN_SLICE = 131072; // 128 KB - granularity within the budget

// The shell posts this id when a file read or a dialog reaches a terminal
// state. It is not a continuation - it means "service the jobs you are
// waiting on". Continuation ids start at 1, so the two can never collide.
const TIMER_JOBS = -1;

/**
 * A running janela app.
 *
 * This is a class rather than an interface because the contract-typed methods
 * below are generic, and scriptc dispatches generic methods statically: it can
 * only compile a call when the receiver's runtime class is provable, which an
 * interface (being signature-only) never is. A class receiver works even as a
 * plain function parameter, which is what `setup(app)` is.
 */
// ---- menus -------------------------------------------------------------
//
// A menu item is an OBJECT that carries its own click handler, not a row with
// an id that something matches on later. muda — Tauri's menu crate — uses ids
// because Rust cannot attach a closure to an item across its global event
// channel, so it hands you `MenuId(String)` and you match on it; a typo there
// is silent. TypeScript has no such problem: the handler lives on the item, so
// there is no name to declare, to keep in sync, or to get wrong.
//
// The tag is an implementation detail the caller never sees: it indexes the
// handler registry here, is written into the wire format, comes back on a
// click, and is what setEnabled/setChecked/setLabel address.

// Modifiers travel SYMBOLICALLY, not as one platform's constants.
//
// They used to be NSEventModifierFlags integers, which only worked because
// macOS was the only renderer. Naming the intent instead lets each platform
// map it — and it is the only way "CmdOrCtrl" can mean what it says, since the
// runtime does not know which platform it was built for.
const MOD_PRIMARY = 1; // CmdOrCtrl: Command on macOS, Control elsewhere
const MOD_SHIFT = 2;
const MOD_ALT = 4; // Option on macOS
const MOD_CTRL = 8; // Control, explicitly, on every platform
const MOD_CMD = 16; // Command, explicitly; ignored where there is none

/** "CmdOrCtrl+Shift+O" -> "o<US>3". Unknown words are taken as the key. */
function parseAccel(accel: string): string {
  const parts = accel.split("+");
  let mods = 0;
  let key = "";
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i].toLowerCase();
    if (p === "cmdorctrl" || p === "commandorcontrol") {
      mods = mods | MOD_PRIMARY;
    } else if (p === "cmd" || p === "command" || p === "meta" || p === "super") {
      mods = mods | MOD_CMD;
    } else if (p === "ctrl" || p === "control") {
      mods = mods | MOD_CTRL;
    } else if (p === "alt" || p === "option") {
      mods = mods | MOD_ALT;
    } else if (p === "shift") {
      mods = mods | MOD_SHIFT;
    } else if (p !== "") {
      key = p;
    }
  }
  return key + "\x1f" + mods;
}

/** 0x1f and newlines are the wire format's own delimiters. */
function menuSafe(v: string): string {
  return v.split("\x1f").join(" ").split("\n").join(" ");
}

/** Submenus and separators have nothing to run. */
function noop(): void {}

/**
 * An entry in the application menu.
 *
 * Build one with `menuItem`, `menuSeparator` or `submenu` and keep the
 * reference if you want to change it later — there is no lookup by name,
 * because there are no names.
 */
export class MenuItem {
  label: string;
  accel: string;
  separator: boolean;
  items: MenuItem[];
  onClick: () => void;
  enabled = true;
  // Data on the base so the flattener can read it without a type test; only
  // CheckMenuItem exposes a way to change it.
  checkable = false;
  checked = false;

  // Assigned when the item is mounted by setMenu; -1 while detached. The
  // window handle is enough to reach the FFI — holding the app itself would
  // drag its two type parameters in here for no benefit.
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

  /**
   * Grey the item out, or bring it back.
   *
   * Applied immediately when the item is already in a menu, and remembered
   * for the next `setMenu` when it is not — so state set before mounting is
   * not lost. The return says which of the two happened: true when the live
   * menu was changed, false when the value was only recorded.
   */
  setEnabled(on: boolean): boolean {
    this.enabled = on;
    if (this.ownerHandle < 0 || this.tag < 0) return false;
    return wvMenuSetEnabled(this.ownerHandle, this.tag, on ? 1 : 0) === 0;
  }

  /** Change the text without rebuilding the menu. */
  setLabel(label: string): boolean {
    this.label = label;
    if (this.ownerHandle < 0 || this.tag < 0) return false;
    return wvMenuSetLabel(this.ownerHandle, this.tag, label) === 0;
  }
}

/**
 * An item that can carry a tick.
 *
 * Separate from `MenuItem` because GTK decides this at construction: a tick
 * needs `GtkCheckMenuItem`, a different widget, and an item cannot become one
 * later. macOS and Windows would let any item show a check, but a method that
 * works on two platforms and silently does nothing on the third is worse than
 * one that is simply absent — so `setChecked` lives here, and calling it on a
 * plain item is a compile error rather than a surprise on Linux.
 */
export class CheckMenuItem extends MenuItem {
  constructor(label: string, accel: string, onClick: () => void) {
    super(label, accel, false, [], onClick);
    this.checkable = true;
  }

  /** Tick or untick the item. Returns as `setEnabled` does. */
  setChecked(on: boolean): boolean {
    this.checked = on;
    if (this.ownerHandle < 0 || this.tag < 0) return false;
    return wvMenuSetChecked(this.ownerHandle, this.tag, on ? 1 : 0) === 0;
  }
}

/** A clickable entry. `accel` is "" for no shortcut. */
export function menuItem(label: string, accel: string, onClick: () => void): MenuItem {
  return new MenuItem(label, accel, false, [], onClick);
}

/**
 * The platform's own actions, callable from anywhere.
 *
 * ```ts
 * const close = menuItem("Close", "CmdOrCtrl+W", () => predefined.close());
 * const copy  = menuItem("Copy",  "CmdOrCtrl+C", () => predefined.copy());
 *
 * // and they compose, which a fixed "predefined item" never could:
 * menuItem("Save and close", "", () => { write(); predefined.close(); });
 * ```
 *
 * Copy, paste and undo are the interesting ones: they are not "do this" but a
 * selector sent up the responder chain, and by the time a handler here runs
 * the menu click has already been delivered to us. So these ask the platform
 * to send the action up the chain at that moment, which is what lets it reach
 * the webview's editing context. `document.execCommand("paste")` cannot —
 * webviews block it.
 *
 * An action with no equivalent on a platform returns false rather than
 * pretending. What exists where:
 *
 * - everywhere: `quit`, `close`, `minimize`, `zoom`, `fullscreen`, `about`,
 *   `undo`, `redo`, `cut`, `copy`, `paste`, `selectAll`
 * - macOS only: `hide`, `hideOthers`, `showAll`
 *
 * The three that stop at macOS are not a missing API but a missing concept.
 * `hide` is application state there — windows vanish, the app stays in the
 * Dock, one click brings it back. Hiding a window on Windows or Linux instead
 * takes it out of the taskbar with no way back short of a tray icon, and
 * `hideOthers` / `showAll` reach into other applications: the nearest Windows
 * call minimizes you too, and on Wayland there is nothing at all.
 *
 * `about` shows each platform's own About box — NSApplication's panel,
 * `ShellAboutW`, `gtk_show_about_dialog` — named after the process, which is
 * what the macOS application menu shows. A richer one is your app's to build.
 *
 * Each platform reaches the editing commands by its own route: AppKit
 * selectors up the responder chain, WebKitGTK's
 * `webkit_web_view_execute_editing_command`, and on Windows the DevTools
 * protocol, since WebView2 runs the page out of process and exposes no
 * copy/paste entry point of its own. On Windows and Linux the call is
 * dispatched rather than awaited, so a `true` there means the browser was
 * asked, not that it has finished.
 */
export const predefined = {
  about: (): boolean => wvPerformAction("about") === 0,
  hide: (): boolean => wvPerformAction("hide") === 0,
  hideOthers: (): boolean => wvPerformAction("hideOthers") === 0,
  showAll: (): boolean => wvPerformAction("showAll") === 0,
  quit: (): boolean => wvPerformAction("quit") === 0,
  close: (): boolean => wvPerformAction("closeWindow") === 0,

  undo: (): boolean => wvPerformAction("undo") === 0,
  redo: (): boolean => wvPerformAction("redo") === 0,
  cut: (): boolean => wvPerformAction("cut") === 0,
  copy: (): boolean => wvPerformAction("copy") === 0,
  paste: (): boolean => wvPerformAction("paste") === 0,
  selectAll: (): boolean => wvPerformAction("selectAll") === 0,

  minimize: (): boolean => wvPerformAction("minimize") === 0,
  zoom: (): boolean => wvPerformAction("zoom") === 0,
  fullscreen: (): boolean => wvPerformAction("fullscreen") === 0,
};

/** A clickable entry that carries a tick. `accel` is "" for no shortcut. */
export function menuCheckItem(label: string, accel: string, onClick: () => void): CheckMenuItem {
  return new CheckMenuItem(label, accel, onClick);
}

/** A divider. */
export function menuSeparator(): MenuItem {
  return new MenuItem("", "", true, [], noop);
}

/** A submenu holding other entries. Nestable. */
export function submenu(label: string, items: MenuItem[]): MenuItem {
  return new MenuItem(label, "", false, items, noop);
}

export class JanelaAppImpl<
  C extends CommandShapes = CommandShapes,
  E = Record<string, unknown>,
> {
  handle: number;
  names: string[] = [];
  handlers: CommandHandler[] = [];

  // Menu items in tag order; the tag IS the index. Rebuilt by setMenu.
  menuItems: MenuItem[] = [];
  // The handlers, separately: scriptc does not support calling a closure held
  // on an object property (SC1090), only one reached through an array — the
  // same reason command handlers live in `handlers`.
  menuHandlers: (() => void)[] = [];
  menuBound = false;

  // ---- scheduling ----------------------------------------------------------
  // scriptc's event loop is parked for as long as the program sits inside the
  // wvRun() FFI call, so setTimeout/await never fire while the window is open.
  // The shell schedules instead: a continuation is parked here under an id and
  // handed to wvSchedule(), and the shim calls onTimer(id) back on the UI
  // thread once it comes due. Nothing here polls and nothing wakes
  // periodically - an idle app is genuinely idle.
  //
  // This is the same shape the iOS shell must use, where the compiled TS links
  // no event loop at all and could not hold a timer even if it wanted to.
  asyncNames: string[] = [];
  asyncHandlers: AsyncCommandHandler[] = [];
  contIds: number[] = [];
  contFns: (() => void)[] = [];
  nextCont = 1; // ids start at 1; TIMER_JOBS (-1) is the shell's own
  jobIds: number[] = [];
  jobCbs: FsCallback[] = [];

  // ---- the drain -----------------------------------------------------------
  // A finished job's bytes still have to be decoded into a TypeScript string,
  // and that cost is proportional to the payload: taking a 100 MB file in one
  // call froze the window for ~240 ms. So a finished job moves here and is
  // decoded a slice at a time, giving the run loop the thread back between
  // slices - total work is unchanged, but no single turn carries much of it.
  drainIds: number[] = [];
  draining = false; // a drain continuation is already queued
  drainCbs: FsCallback[] = [];
  drainOk: boolean[] = [];
  drainParts: string[][] = [];
  drainOff: number[] = [];
  drainSize: number[] = [];

  constructor(cfg: WindowConfig) {
    const h = wvCreate(0);
    this.handle = h;
    wvSetTitle(h, cfg.title);
    wvSetSize(h, cfg.width, cfg.height, 0);
    wvInit(h, BOOTSTRAP);
  }

  /**
   * Park `fn` with the shell and ask to be called back in `ms`.
   *
   * The id is the whole protocol: TS keeps the closure, the shell keeps the
   * clock, and neither needs to know anything else about the other.
   */
  schedule(ms: number, fn: () => void): void {
    const id = this.nextCont;
    this.nextCont = id + 1;
    this.contIds.push(id);
    this.contFns.push(fn);
    const delay = ms > 0 ? ms : 0;
    const rc = wvSchedule(this.handle, id, delay);
    if (rc < 0) console.log("[janela] could not schedule continuation", id);
  }

  /** Run the continuation parked under `id`, if it is still waiting. */
  runCont(id: number): void {
    for (let i = 0; i < this.contIds.length; i++) {
      if (this.contIds[i] === id) {
        const fn = this.contFns[i];
        // Unregister BEFORE running: a continuation that schedules another one
        // must not disturb the entry being removed, and a continuation that
        // throws must not stay parked forever.
        this.contIds.splice(i, 1);
        this.contFns.splice(i, 1);
        fn();
        return;
      }
    }
  }

  // Decode as much of the pending payloads as the budget allows, then yield.
  // Slices are taken from one job at a time so a big read finishes promptly
  // rather than every concurrent read finishing slowly.
  /**
   * Decode as much of the pending payloads as the budget allows, then hand the
   * thread back. If work remains, a zero-delay continuation carries on at the
   * top of the next turn, so a 100 MB read is spread across frames instead of
   * freezing one.
   */
  drainSome(): void {
    if (this.drainIds.length === 0) return;
    const started = Date.now();

    while (this.drainIds.length > 0) {
      let chunk = "";
      const taken =
        wvJobTakeAt(this.handle, this.drainIds[0], this.drainOff[0], DRAIN_SLICE, (text) => {
          chunk = text;
        });

      // A negative count means the job vanished; treat the payload as final
      // rather than spinning on it forever.
      if (taken > 0) {
        this.drainParts[0].push(chunk);
        this.drainOff[0] = this.drainOff[0] + taken;
      }

      if (taken <= 0 || this.drainOff[0] >= this.drainSize[0]) {
        // Joining is one unavoidable O(n) copy: the callback is handed a
        // single string, so the whole payload must be materialised once.
        const payload = this.drainParts[0].join("");
        const cb = this.drainCbs[0];
        const ok = this.drainOk[0];
        wvJobFree(this.handle, this.drainIds[0]);

        this.drainIds = this.drainIds.slice(1);
        this.drainCbs = this.drainCbs.slice(1);
        this.drainOk = this.drainOk.slice(1);
        this.drainParts = this.drainParts.slice(1);
        this.drainOff = this.drainOff.slice(1);
        this.drainSize = this.drainSize.slice(1);

        if (ok) {
          cb(null, payload);
        } else {
          cb(payload, "");
        }
        // User code just ran and may have taken a while; re-check the budget
        // before starting another payload.
      }

      if (Date.now() - started >= DRAIN_BUDGET_MS) {
        this.drainMore();
        return;
      }
    }
  }

  /** Continue draining on the next turn, without stacking duplicate work. */
  drainMore(): void {
    if (this.drainIds.length === 0 || this.draining) return;
    this.draining = true;
    this.schedule(0, () => {
      this.draining = false;
      this.drainSome();
    });
  }

  /**
   * The shell calls here on the UI thread when something it was holding comes
   * due: a continuation TS parked (id >= 1), or a job that finished
   * (TIMER_JOBS). This is the only entry into the loop, and it always lands at
   * the top of a fresh turn — never underneath a TS frame.
   */
  onTimer(id: number): void {
    if (id !== TIMER_JOBS) {
      this.runCont(id);
      return;
    }
    this.serviceJobs();
  }

  /** A job reached a terminal state: move the finished ones to the drain. */
  serviceJobs(): void {
    if (this.jobIds.length > 0) {
      const keptIds: number[] = [];
      const keptCbs: FsCallback[] = [];
      const doneIds: number[] = [];
      const doneCbs: FsCallback[] = [];
      const doneOk: boolean[] = [];
      for (let i = 0; i < this.jobIds.length; i++) {
        const st = wvJobStatus(this.handle, this.jobIds[i]);
        if (st === JOB_PENDING) {
          keptIds.push(this.jobIds[i]);
          keptCbs.push(this.jobCbs[i]);
        } else {
          doneIds.push(this.jobIds[i]);
          doneCbs.push(this.jobCbs[i]);
          doneOk.push(st === JOB_OK);
        }
      }
      this.jobIds = keptIds;
      this.jobCbs = keptCbs;
      for (let i = 0; i < doneIds.length; i++) {
        // On failure the payload IS the error message, so one path serves both
        // outcomes. Nothing is decoded here: the job joins the drain queue and
        // its bytes are taken a slice at a time, under a time budget.
        this.drainIds.push(doneIds[i]);
        this.drainCbs.push(doneCbs[i]);
        this.drainOk.push(doneOk[i]);
        this.drainParts.push([]);
        this.drainOff.push(0);
        this.drainSize.push(wvJobSize(this.handle, doneIds[i]));
      }
    }

    this.drainSome();
  }

  // Both dialog kinds share one path: start the job, then let the same drain
  // that serves file I/O deliver the answer on a later turn.
  startDialog(
    kind: number,
    flags: number,
    title: string | undefined,
    defaultPath: string | undefined,
    defaultName: string | undefined,
    filters: DialogFilter[] | undefined,
    cb: (paths: string[] | null, err?: string) => void,
  ): void {
    const id = wvDialog(
      this.handle,
      kind,
      flags,
      title === undefined ? "" : title,
      defaultPath === undefined ? "" : defaultPath,
      defaultName === undefined ? "" : defaultName,
      encodeFilters(filters),
    );
    if (id < 0) {
      this.defer(() => cb(null, "EAGAIN: could not open a dialog"));
      return;
    }
    this.jobIds.push(id);
    this.jobCbs.push((err, text) => {
      if (err !== null) {
        cb(null, err);
        return;
      }
      // "null" is a cancel; anything else is a JSON array of paths.
      cb(JSON.parse(text) as string[] | null);
    });
  }

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
   * Register a command that answers later; see AsyncCommandHandler. Under a
   * contract, `resolve` takes exactly the declared result type.
   */
  commandAsync<K extends keyof C & string>(
    name: K,
    handler: (
      args: C[K]["args"],
      resolve: (value: C[K]["result"]) => void,
      reject: (reason: unknown) => void,
    ) => void,
  ): void {
    this.asyncNames.push(name);
    this.asyncHandlers.push(
      (args: unknown, resolve: (v: unknown) => void, reject: (r: unknown) => void) => {
        handler(args as C[K]["args"], (value: C[K]["result"]) => resolve(value), reject);
      },
    );
  }

  /** Run fn on the next turn of the host loop - the way to slice long work. */
  defer(fn: () => void): void {
    // Zero delay: the shell posts straight to the next turn, no timer at all.
    this.schedule(0, fn);
  }

  /** Run fn after at least ms. The shell owns the clock; scriptc's setTimeout
   *  cannot fire while the window is open (its loop is parked inside run()). */
  sleep(ms: number, fn: () => void): void {
    this.schedule(ms, fn);
  }

  /**
   * Read a file without blocking the window. The syscall runs on a shim
   * worker thread; the callback lands on the UI thread on a later turn.
   */
  readFileAsync(path: string, cb: FsCallback): void {
    const id = wvFsRead(this.handle, path);
    if (id < 0) {
      this.defer(() => cb("EAGAIN: could not start a read of '" + path + "'", ""));
      return;
    }
    this.jobIds.push(id);
    this.jobCbs.push(cb);
  }

  /** Write a file without blocking the window; cb(null) on success. */
  writeFileAsync(path: string, data: string, cb: (err: string | null) => void): void {
    const id = wvFsWrite(this.handle, path, data);
    if (id < 0) {
      this.defer(() => cb("EAGAIN: could not start a write of '" + path + "'"));
      return;
    }
    this.jobIds.push(id);
    // The write payload is empty on success; the shared callback shape just
    // ignores the text argument.
    this.jobCbs.push((err, _text) => cb(err));
  }

  /** Show the native "open" dialog; cb gets the paths, or null on cancel. */
  openFileDialog(
    options: OpenDialogOptions,
    cb: (paths: string[] | null, err?: string) => void,
  ): void {
    let flags = 0;
    if (options.multiple === true) flags = flags + DLG_MULTIPLE;
    if (options.directory === true) flags = flags + DLG_DIRECTORY;
    this.startDialog(DLG_OPEN, flags, options.title, options.defaultPath, "",
      options.filters, (paths, err) => cb(paths, err));
  }

  /** Show the native "save" dialog; cb gets the path, or null on cancel. */
  saveFileDialog(
    options: SaveDialogOptions,
    cb: (path: string | null, err?: string) => void,
  ): void {
    this.startDialog(DLG_SAVE, 0, options.title, options.defaultPath,
      options.defaultName, options.filters, (paths, err) => {
        if (paths === null) {
          cb(null, err);
          return;
        }
        cb(paths.length > 0 ? paths[0] : null, err);
      });
  }

  /** Change the window title at any time, not just at startup. */
  setTitle(title: string): void {
    wvSetTitle(this.handle, title);
  }

  /** Resize the window. `hint`: 0 none, 1 minimum, 2 maximum, 3 fixed. */
  setSize(width: number, height: number, hint?: number): void {
    wvSetSize(this.handle, width, height, hint === undefined ? 0 : hint);
  }

  /** Enter or leave fullscreen. */
  setFullscreen(on: boolean): void {
    wvSetFullscreen(this.handle, on ? 1 : 0);
  }

  /**
   * Put submenus in the application menu.
   *
   * They are ADDED to the standard ones rather than replacing them, so a
   * custom menu can never cost the app Cmd+Q or Cmd+V — replacing the bar
   * wholesale is what would. Calling it again replaces only what a previous
   * call added, so the menu can shrink as well as grow.
   *
   * Each item carries its own handler; there are no ids to declare or match.
   * Keep a reference to change an item later.
   *
   * ```ts
   * const save = menuItem("Save", "CmdOrCtrl+S", () => write());
   * app.setMenu([submenu("File", [
   *   menuItem("Open…", "CmdOrCtrl+O", () => open()),
   *   menuSeparator(),
   *   save,
   * ])]);
   *
   * save.setEnabled(false);   // later, without rebuilding
   * ```
   *
   * Renders on all three desktop platforms: an NSMenu bar, a Win32 menu, or a
   * GtkMenuBar above the webview. Returns false if the platform refused —
   * GTK 4, where GtkMenuBar no longer exists, is the one case that does.
   *
   * What differs is the FLOOR beneath it. macOS gets a standard bar whether
   * you set one or not, because there a Command shortcut is a menu key
   * equivalent and an app with no menu has no Cmd+Q or Cmd+V. Windows and
   * Linux need no such floor: Alt+F4 is the window manager's, and the editing
   * keys belong to WebView2 and WebKitGTK. So an app that never calls this
   * has a full menu bar on macOS and none elsewhere — which is what an app
   * with nothing in its menus should look like on each.
   */
  setMenu(entries: MenuItem[]): boolean {
    // A rebuild invalidates every tag from the previous call, so the registry
    // is rebuilt with it. Items carried over keep working because they are
    // re-tagged here; items dropped from the tree go inert, which is what
    // "removed from the menu" should mean.
    for (let i = 0; i < this.menuItems.length; i++) {
      this.menuItems[i].tag = -1;
      this.menuItems[i].ownerHandle = -1;
    }
    this.menuItems = [];
    this.menuHandlers = [];

    const rows: string[] = [];
    this.flattenMenu(entries, rows);

    if (!this.menuBound) {
      // Registered once: the tag comes back and the item's own closure runs.
      wvOnMenu(this.handle, (tag) => {
        if (tag >= 0 && tag < this.menuHandlers.length) this.menuHandlers[tag]();
        return 0;
      });
      this.menuBound = true;
    }
    return wvSetMenu(this.handle, rows.join("\n")) === 0;
  }

  /** Walks the tree, assigns each clickable item its registry tag. */
  flattenMenu(entries: MenuItem[], rows: string[]): void {
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e.separator) {
        rows.push("-");
        continue;
      }
      const label = menuSafe(e.label);
      if (e.items.length > 0) {
        rows.push("S\x1f" + label);
        this.flattenMenu(e.items, rows);
        rows.push("E");
        continue;
      }
      const tag = this.menuItems.length;
      this.menuItems.push(e);
      this.menuHandlers.push(e.onClick);
      e.tag = tag;
      e.ownerHandle = this.handle;
      rows.push(
        "I\x1f" + tag + "\x1f" + label + "\x1f" + parseAccel(e.accel) +
          "\x1f" + (e.enabled ? "1" : "0") + "\x1f" + (e.checked ? "1" : "0") +
          "\x1f" + (e.checkable ? "1" : "0"),
      );
    }
  }

  /**
   * Fire an event into the page; the payload is delivered as a value. Under a
   * contract, the name must be declared and the payload must match its type.
   */
  emit<K extends keyof E & string>(event: K, payload: E[K]): void {
    wvEval(
      this.handle,
      "window.__wvEmit(" + JSON.stringify(event) + "," + encode(payload) + ");",
    );
  }

  /** Close the window and make run() return. */
  quit(): void {
    wvTerminate(this.handle);
  }

  /** Show the page and block until the window closes. Returns the run status. */
  run(html: string): number {
    const h = this.handle;
    // Both handlers are retained: registered once here, called by the shim
    // for as long as the window is open.
    wvOnTimer(h, (id) => {
      this.onTimer(id);
    });
    wvOnInvoke(h, (req) => {
      const env = JSON.parse(req) as string[];
      const cmd = env[0];
      const args = JSON.parse(env[1]) as unknown;
      for (let i = 0; i < this.names.length; i++) {
        if (this.names[i] === cmd) {
          wvReply(h, encode(this.handlers[i](args)));
          return 0;
        }
      }
      for (let i = 0; i < this.asyncNames.length; i++) {
        if (this.asyncNames[i] === cmd) {
          // Park the page's promise: the shim holds this call's id and
          // answers it when resolve/reject reaches wvResolve, whenever
          // that is. Meanwhile the loop is free to serve other calls.
          const id = wvDefer(h);
          if (id < 0) {
            wvReply(h, encode("cannot defer command: " + cmd));
            return 1;
          }
          const settle = (status: number): ((value: unknown) => void) => {
            let done = false;
            return (value: unknown) => {
              if (done) return; // a promise settles once
              done = true;
              wvReply(h, encode(value));
              wvResolve(h, id, status);
            };
          };
          this.asyncHandlers[i](args, settle(0), settle(1));
          return 0;
        }
      }
      wvReply(h, encode("unknown command: " + cmd));
      return 1; // rejects the frontend promise
    });

    wvBind(h, "__invoke");
    wvSetHtml(h, html);
    const rc = wvRun(h);
    return rc;
  }
}

/**
 * A running janela app, typed by the contract it serves.
 *
 * This is an alias rather than the class itself so that a contract may be
 * written as plain function types: `Norm` converts it to the record form the
 * class indexes, at a point where the table is still concrete. Writing the
 * record form directly keeps working — `Norm` is idempotent.
 *
 * ```ts
 * export type AppCommands = { add: (args: { a: number; b: number }) => number };
 * export type AppEvents = { added: number };
 * export type App = JanelaApp<AppCommands, AppEvents>;
 *
 * export function setup(app: App): void {
 *   app.command("add", (args) => args.a + args.b);   // args inferred, result checked
 * }
 * ```
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
// These were the shape before the app itself carried the contract. They still
// work; prefer app.command / app.commandAsync / app.emit.

/** @deprecated Use `app.command(name, handler)` on a contract-typed app. */
export function on<M extends CommandShapes, K extends keyof M & string>(
  app: JanelaAppImpl,
  _commands: Commands<M>,
  name: K,
  handler: (args: M[K]["args"]) => M[K]["result"],
): void {
  app.command(name, (args: unknown) => handler(args as M[K]["args"]));
}

/** @deprecated Use `app.commandAsync(name, handler)` on a contract-typed app. */
export function onAsync<M extends CommandShapes, K extends keyof M & string>(
  app: JanelaAppImpl,
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
    (args: unknown, resolve: (v: unknown) => void, reject: (r: unknown) => void) => {
      handler(args as M[K]["args"], (value: M[K]["result"]) => resolve(value), reject);
    },
  );
}

/** @deprecated Use `app.emit(event, payload)` on a contract-typed app. */
export function emit<E, K extends keyof E & string>(
  app: JanelaAppImpl,
  _events: Events<E>,
  name: K,
  payload: E[K],
): void {
  app.emit(name, payload as unknown);
}
