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
  "  }," +
  "};" +
  "window.__wvEmit = function (event, payload) {" +
  "  var cbs = window.__wvListeners[event] || [];" +
  "  for (var i = 0; i < cbs.length; i++) cbs[i](payload);" +
  "};";

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

// JSON.stringify yields undefined for undefined; the wire always needs a
// value, and a command that returns nothing should read as null in the page.
function encode(value: unknown): string {
  if (value === undefined) return "null";
  return JSON.stringify(value);
}

export function createApp(cfg: WindowConfig): JanelaApp {
  const h = wvCreate(0) + 0;
  wvSetTitle(h, cfg.title);
  wvSetSize(h, cfg.width, cfg.height, 0);
  wvInit(h, BOOTSTRAP);

  // ---- the host loop -------------------------------------------------------
  // scriptc's event loop is parked for as long as the program sits inside the
  // wvRun() FFI call, so setTimeout/await never fire while the window is open.
  // These queues are drained instead by the retained tick handler that the
  // shim's ticker posts to the UI thread, and the ticker only runs while there
  // is work — an idle app costs nothing.
  const asyncNames: string[] = [];
  const asyncHandlers: AsyncCommandHandler[] = [];
  let taskFns: (() => void)[] = [];
  let timerFns: (() => void)[] = [];
  let timerDue: number[] = [];
  let jobIds: number[] = [];
  let jobCbs: FsCallback[] = [];
  let ticking = false;

  // ---- the drain -----------------------------------------------------------
  // A finished job's bytes still have to be decoded into a TypeScript string,
  // and that cost is proportional to the payload: taking a 100 MB file in one
  // call froze the window for ~240 ms. So a finished job moves here and is
  // decoded a slice at a time, giving the run loop the thread back between
  // slices — total work is unchanged, but no single turn carries much of it.
  //
  // The budget is wall-clock rather than a byte count on purpose: a fixed
  // chunk size fixes the WORST turn but also caps throughput (128 KB per 8 ms
  // tick would cap reads at ~16 MB/s), whereas a time budget spends whatever
  // the machine can do in the time available.
  const DRAIN_BUDGET_MS = 4; // ≈ a quarter of a 60fps frame
  const DRAIN_SLICE = 131072; // 128 KB — granularity within the budget
  let drainIds: number[] = [];
  let drainCbs: FsCallback[] = [];
  let drainOk: boolean[] = [];
  let drainParts: string[][] = [];
  let drainOff: number[] = [];
  let drainSize: number[] = [];

  // Tick interval: 8 ms is plenty for timers and task chains, but while a
  // payload is draining the loop is doing real work every turn, and waiting
  // 8 ms between 4 ms slices would halve throughput for no benefit. So the
  // ticker runs tighter for as long as there is a payload in flight.
  const TICK_IDLE_MS = 8;
  const TICK_DRAIN_MS = 4;
  let tickMs = TICK_IDLE_MS;

  const retick = (): void => {
    const want = drainIds.length > 0 ? TICK_DRAIN_MS : TICK_IDLE_MS;
    if (!ticking || want === tickMs) return;
    tickMs = want;
    wvTickStart(h, want);
  };

  const wake = (): void => {
    if (ticking) return;
    ticking = true;
    tickMs = drainIds.length > 0 ? TICK_DRAIN_MS : TICK_IDLE_MS;
    wvTickStart(h, tickMs);
  };

  const idle = (): void => {
    if (!ticking) return;
    if (
      taskFns.length > 0 ||
      timerFns.length > 0 ||
      jobIds.length > 0 ||
      drainIds.length > 0
    ) {
      return;
    }
    ticking = false;
    wvTickStop(h);
  };

  // Decode as much of the pending payloads as the budget allows, then yield.
  // Slices are taken from one job at a time so a big read finishes promptly
  // rather than every concurrent read finishing slowly.
  const drainSome = (): void => {
    if (drainIds.length === 0) return;
    const started = Date.now() + 0;

    while (drainIds.length > 0) {
      let chunk = "";
      const taken =
        wvJobTakeAt(h, drainIds[0], drainOff[0], DRAIN_SLICE, (text) => {
          chunk = text;
        }) + 0;

      // A negative count means the job vanished; treat the payload as final
      // rather than spinning on it forever.
      if (taken > 0) {
        drainParts[0].push(chunk);
        drainOff[0] = drainOff[0] + taken;
      }

      if (taken <= 0 || drainOff[0] >= drainSize[0]) {
        // Joining is one unavoidable O(n) copy: the callback is handed a
        // single string, so the whole payload must be materialised once.
        const payload = drainParts[0].join("");
        const cb = drainCbs[0];
        const ok = drainOk[0];
        wvJobFree(h, drainIds[0]);

        drainIds = drainIds.slice(1);
        drainCbs = drainCbs.slice(1);
        drainOk = drainOk.slice(1);
        drainParts = drainParts.slice(1);
        drainOff = drainOff.slice(1);
        drainSize = drainSize.slice(1);

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
  };

  // One turn of the loop: every task queued so far, plus every due timer.
  // Tasks queued *by* this turn wait for the next one, so a defer() chain
  // yields to the UI between slices instead of starving it.
  const turn = (): void => {
    const tasks = taskFns;
    taskFns = [];
    for (let i = 0; i < tasks.length; i++) tasks[i]();

    if (timerFns.length > 0) {
      const now = Date.now() + 0;
      const keptFns: (() => void)[] = [];
      const keptDue: number[] = [];
      const fire: (() => void)[] = [];
      for (let i = 0; i < timerFns.length; i++) {
        if (timerDue[i] <= now) {
          fire.push(timerFns[i]);
        } else {
          keptFns.push(timerFns[i]);
          keptDue.push(timerDue[i]);
        }
      }
      timerFns = keptFns;
      timerDue = keptDue;
      for (let i = 0; i < fire.length; i++) fire[i]();
    }

    // Finished file jobs: the worker thread has already done the blocking
    // syscall, so all that happens on this (UI) thread is the drain.
    if (jobIds.length > 0) {
      const keptIds: number[] = [];
      const keptCbs: FsCallback[] = [];
      const doneIds: number[] = [];
      const doneCbs: FsCallback[] = [];
      const doneOk: boolean[] = [];
      for (let i = 0; i < jobIds.length; i++) {
        const st = wvJobStatus(h, jobIds[i]) + 0;
        if (st === JOB_PENDING) {
          keptIds.push(jobIds[i]);
          keptCbs.push(jobCbs[i]);
        } else {
          doneIds.push(jobIds[i]);
          doneCbs.push(jobCbs[i]);
          doneOk.push(st === JOB_OK);
        }
      }
      jobIds = keptIds;
      jobCbs = keptCbs;
      for (let i = 0; i < doneIds.length; i++) {
        // On failure the payload IS the error message, so one path serves both
        // outcomes. Nothing is decoded here: the job joins the drain queue and
        // its bytes are taken a slice at a time, under a time budget.
        drainIds.push(doneIds[i]);
        drainCbs.push(doneCbs[i]);
        drainOk.push(doneOk[i]);
        drainParts.push([]);
        drainOff.push(0);
        drainSize.push(wvJobSize(h, doneIds[i]) + 0);
      }
    }

    drainSome();
    retick();
    idle();
  };

  // Filters cross as "Name|ext,ext|Name|ext" — the shim needs no JSON parser
  // for what is always a short, flat list.
  const encodeFilters = (filters: DialogFilter[] | undefined): string => {
    if (filters === undefined || filters.length === 0) return "";
    const parts: string[] = [];
    for (let i = 0; i < filters.length; i++) {
      parts.push(filters[i].name);
      parts.push(filters[i].extensions.join(","));
    }
    return parts.join("|");
  };

  // Both dialog kinds share one path: start the job, then let the same drain
  // that serves file I/O deliver the answer on a later turn.
  const startDialog = (
    kind: number,
    flags: number,
    title: string | undefined,
    defaultPath: string | undefined,
    defaultName: string | undefined,
    filters: DialogFilter[] | undefined,
    cb: (paths: string[] | null, err?: string) => void,
  ): void => {
    const id = wvDialog(
      h,
      kind,
      flags,
      title === undefined ? "" : title,
      defaultPath === undefined ? "" : defaultPath,
      defaultName === undefined ? "" : defaultName,
      encodeFilters(filters),
    ) + 0;
    if (id < 0) {
      taskFns.push(() => cb(null, "EAGAIN: could not open a dialog"));
      wake();
      return;
    }
    jobIds.push(id);
    jobCbs.push((err, text) => {
      if (err !== null) {
        cb(null, err);
        return;
      }
      // "null" is a cancel; anything else is a JSON array of paths.
      cb(JSON.parse(text) as string[] | null);
    });
    wake();
  };

  const app: JanelaApp = {
    handle: h,
    names: [],
    handlers: [],

    command: (name, handler) => {
      app.names.push(name);
      app.handlers.push(handler);
    },

    commandAsync: (name, handler) => {
      asyncNames.push(name);
      asyncHandlers.push(handler);
    },

    defer: (fn) => {
      taskFns.push(fn);
      wake();
    },

    sleep: (ms, fn) => {
      timerFns.push(fn);
      timerDue.push(Date.now() + (ms > 0 ? ms : 0));
      wake();
    },

    readFileAsync: (path, cb) => {
      const id = wvFsRead(h, path) + 0;
      if (id < 0) {
        app.defer(() => cb("EAGAIN: could not start a read of '" + path + "'", ""));
        return;
      }
      jobIds.push(id);
      jobCbs.push(cb);
      wake();
    },

    writeFileAsync: (path, data, cb) => {
      const id = wvFsWrite(h, path, data) + 0;
      if (id < 0) {
        app.defer(() => cb("EAGAIN: could not start a write of '" + path + "'"));
        return;
      }
      jobIds.push(id);
      // The write payload is empty on success; the shared callback shape just
      // ignores the text argument.
      jobCbs.push((err, _text) => cb(err));
      wake();
    },

    openFileDialog: (options, cb) => {
      let flags = 0;
      if (options.multiple === true) flags = flags + DLG_MULTIPLE;
      if (options.directory === true) flags = flags + DLG_DIRECTORY;
      startDialog(DLG_OPEN, flags, options.title, options.defaultPath, "",
        options.filters, (paths, err) => cb(paths, err));
    },

    saveFileDialog: (options, cb) => {
      startDialog(DLG_SAVE, 0, options.title, options.defaultPath,
        options.defaultName, options.filters, (paths, err) => {
          if (paths === null) {
            cb(null, err);
            return;
          }
          cb(paths.length > 0 ? paths[0] : null, err);
        });
    },

    setTitle: (title) => {
      wvSetTitle(h, title);
    },

    setSize: (width, height, hint) => {
      wvSetSize(h, width, height, hint === undefined ? 0 : hint);
    },

    setFullscreen: (on) => {
      wvSetFullscreen(h, on ? 1 : 0);
    },

    emit: (event, payload) => {
      wvEval(
        h,
        "window.__wvEmit(" + JSON.stringify(event) + "," + encode(payload) + ");",
      );
    },

    quit: () => {
      wvTerminate(h);
    },

    run: (html) => {
      // Both handlers are retained: registered once here, called by the shim
      // for as long as the window is open.
      wvOnTick(h, turn);
      wvOnInvoke(h, (req) => {
        const env = JSON.parse(req) as string[];
        const cmd = env[0];
        const args = JSON.parse(env[1]) as unknown;
        for (let i = 0; i < app.names.length; i++) {
          if (app.names[i] === cmd) {
            wvReply(h, encode(app.handlers[i](args)));
            return 0;
          }
        }
        for (let i = 0; i < asyncNames.length; i++) {
          if (asyncNames[i] === cmd) {
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
            asyncHandlers[i](args, settle(0), settle(1));
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
    },
  };
  return app;
}
