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
declare function wvOnTick(h: number, cb: () => void): number;
declare function wvRun(h: number): number;
declare function wvTerminate(h: number): number;
declare function wvDefer(h: number): number;
declare function wvResolve(h: number, id: number, status: number): number;
declare function wvTickStart(h: number, intervalMs: number): number;
declare function wvTickStop(h: number): number;
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
  AsyncCommandHandler,
  CommandHandler,
  CommandShape,
  CommandShapes,
  Commands,
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
  Commands,
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

// 8 ms is plenty for timers and task chains, but while a payload is draining
// the loop does real work every turn, and waiting 8 ms between 4 ms slices
// would halve throughput for no benefit.
const TICK_IDLE_MS = 8;
const TICK_DRAIN_MS = 4;

/**
 * A running janela app.
 *
 * This is a class rather than an interface because the contract-typed methods
 * below are generic, and scriptc dispatches generic methods statically: it can
 * only compile a call when the receiver's runtime class is provable, which an
 * interface (being signature-only) never is. A class receiver works even as a
 * plain function parameter, which is what `setup(app)` is.
 */
export class JanelaApp {
  handle: number;
  names: string[] = [];
  handlers: CommandHandler[] = [];

  // ---- the host loop -------------------------------------------------------
  // scriptc's event loop is parked for as long as the program sits inside the
  // wvRun() FFI call, so setTimeout/await never fire while the window is open.
  // These queues are drained instead by the retained tick handler that the
  // shim's ticker posts to the UI thread, and the ticker only runs while there
  // is work - an idle app costs nothing.
  asyncNames: string[] = [];
  asyncHandlers: AsyncCommandHandler[] = [];
  taskFns: (() => void)[] = [];
  timerFns: (() => void)[] = [];
  timerDue: number[] = [];
  jobIds: number[] = [];
  jobCbs: FsCallback[] = [];
  ticking = false;
  tickMs = TICK_IDLE_MS;

  // ---- the drain -----------------------------------------------------------
  // A finished job's bytes still have to be decoded into a TypeScript string,
  // and that cost is proportional to the payload: taking a 100 MB file in one
  // call froze the window for ~240 ms. So a finished job moves here and is
  // decoded a slice at a time, giving the run loop the thread back between
  // slices - total work is unchanged, but no single turn carries much of it.
  drainIds: number[] = [];
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

  retick(): void {
    const want = this.drainIds.length > 0 ? TICK_DRAIN_MS : TICK_IDLE_MS;
    if (!this.ticking || want === this.tickMs) return;
    this.tickMs = want;
    wvTickStart(this.handle, want);
  }

  wake(): void {
    if (this.ticking) return;
    this.ticking = true;
    this.tickMs = this.drainIds.length > 0 ? TICK_DRAIN_MS : TICK_IDLE_MS;
    wvTickStart(this.handle, this.tickMs);
  }

  idle(): void {
    if (!this.ticking) return;
    if (
      this.taskFns.length > 0 ||
      this.timerFns.length > 0 ||
      this.jobIds.length > 0 ||
      this.drainIds.length > 0
    ) {
      return;
    }
    this.ticking = false;
    wvTickStop(this.handle);
  }

  // Decode as much of the pending payloads as the budget allows, then yield.
  // Slices are taken from one job at a time so a big read finishes promptly
  // rather than every concurrent read finishing slowly.
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

      if (Date.now() - started >= DRAIN_BUDGET_MS) return;
    }
  }

  // One turn of the loop: every task queued so far, plus every due timer.
  // Tasks queued *by* this turn wait for the next one, so a defer() chain
  // yields to the UI between slices instead of starving it.
  turn(): void {
    const tasks = this.taskFns;
    this.taskFns = [];
    for (let i = 0; i < tasks.length; i++) tasks[i]();

    if (this.timerFns.length > 0) {
      const now = Date.now() + 0;
      const keptFns: (() => void)[] = [];
      const keptDue: number[] = [];
      const fire: (() => void)[] = [];
      for (let i = 0; i < this.timerFns.length; i++) {
        if (this.timerDue[i] <= now) {
          fire.push(this.timerFns[i]);
        } else {
          keptFns.push(this.timerFns[i]);
          keptDue.push(this.timerDue[i]);
        }
      }
      this.timerFns = keptFns;
      this.timerDue = keptDue;
      for (let i = 0; i < fire.length; i++) fire[i]();
    }

    // Finished file jobs: the worker thread has already done the blocking
    // syscall, so all that happens on this (UI) thread is the drain.
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
    this.retick();
    this.idle();
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
      this.taskFns.push(() => cb(null, "EAGAIN: could not open a dialog"));
      this.wake();
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
    this.wake();
  }

  /** Register a named command, callable from the page as janela.invoke(name, args). */
  command(name: string, handler: CommandHandler): void {
    this.names.push(name);
    this.handlers.push(handler);
  }

  /** Register a command that answers later; see AsyncCommandHandler. */
  commandAsync(name: string, handler: AsyncCommandHandler): void {
    this.asyncNames.push(name);
    this.asyncHandlers.push(handler);
  }

  /** Run fn on the next turn of the host loop - the way to slice long work. */
  defer(fn: () => void): void {
    this.taskFns.push(fn);
    this.wake();
  }

  /** Run fn after at least ms. The host loop's timer; scriptc's setTimeout
   *  cannot fire while the window is open (its loop is parked inside run()). */
  sleep(ms: number, fn: () => void): void {
    this.timerFns.push(fn);
    this.timerDue.push(Date.now() + (ms > 0 ? ms : 0));
    this.wake();
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
    this.wake();
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
    this.wake();
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

  /** Fire an event into the page; the payload is delivered as a value. */
  emit(event: string, payload: unknown): void {
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
    wvOnTick(h, () => {
      this.turn();
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

export function createApp(cfg: WindowConfig): JanelaApp {
  return new JanelaApp(cfg);
}
