// janela.ts — the janela runtime, compiled into the app by scriptc.
//
// The Tauri-shaped surface: one `__invoke` binding carries every command as a
// (name, argsJson) envelope, dispatched to handlers registered on the app
// object. Handlers see decoded values — the runtime owns JSON at the boundary.
// Backend→frontend events ride wv_eval into the injected bootstrap.
//
// NOTE ON STYLE: every FFI call whose result initializes a variable is written
// `f(...) + 0`. scriptc miscompiles a bare FFI call used as a complete
// initializer/assignment RHS — still true in 0.0.35, and reported upstream as
// vercel-labs/scriptc#21. Any enclosing expression is the workaround.

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
export class JanelaAppImpl<
  C extends CommandShapes = CommandShapes,
  E = Record<string, unknown>,
> {
  handle: number;
  names: string[] = [];
  handlers: CommandHandler[] = [];

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
    const h = wvCreate(0) + 0;
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
    // `+ 0` per the note at the top of this file: a bare FFI call is not safe
    // in every position, and this one is silently dropped without it.
    const rc = wvSchedule(this.handle, id, delay) + 0;
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
    const started = Date.now() + 0;

    while (this.drainIds.length > 0) {
      let chunk = "";
      const taken =
        wvJobTakeAt(this.handle, this.drainIds[0], this.drainOff[0], DRAIN_SLICE, (text) => {
          chunk = text;
        }) + 0;

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
        const st = wvJobStatus(this.handle, this.jobIds[i]) + 0;
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
        this.drainSize.push(wvJobSize(this.handle, doneIds[i]) + 0);
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
    ) + 0;
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
    const id = wvFsRead(this.handle, path) + 0;
    if (id < 0) {
      this.defer(() => cb("EAGAIN: could not start a read of '" + path + "'", ""));
      return;
    }
    this.jobIds.push(id);
    this.jobCbs.push(cb);
  }

  /** Write a file without blocking the window; cb(null) on success. */
  writeFileAsync(path: string, data: string, cb: (err: string | null) => void): void {
    const id = wvFsWrite(this.handle, path, data) + 0;
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
          const id = wvDefer(h) + 0;
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
    const rc = wvRun(h) + 0;
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
