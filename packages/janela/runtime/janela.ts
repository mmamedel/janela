// janela.ts — the janela runtime, compiled into the app by scriptc.
//
// The Tauri-shaped surface: one `__invoke` binding carries every command as a
// (name, argsJson) envelope, dispatched to handlers registered on the app
// object. Backend→frontend events ride wv_eval into the injected bootstrap.
//
// NOTE ON STYLE: every FFI call whose result initializes a variable is written
// `f(...) + 0`. scriptc 0.0.32 miscompiles a bare FFI call used as a complete
// initializer/assignment RHS (see FINDINGS.md); any enclosing expression is
// the workaround.

declare function wvCreate(debug: number): number;
declare function wvSetTitle(h: number, title: string): number;
declare function wvSetSize(h: number, w: number, ht: number, hint: number): number;
declare function wvSetHtml(h: number, html: string): number;
declare function wvInit(h: number, js: string): number;
declare function wvEval(h: number, js: string): number;
declare function wvBind(h: number, name: string): number;
declare function wvReqLen(h: number): number;
declare function wvReqByte(h: number, i: number): number;
declare function wvReplyReset(h: number): number;
declare function wvReplyPush(h: number, b: number): number;
declare function wvRun(h: number, cb: (bindIndex: number, seq: number) => number): number;
declare function wvTerminate(h: number): number;
declare function wvDefer(h: number): number;
declare function wvResolve(h: number, id: number, status: number): number;
declare function wvTickStart(h: number, intervalMs: number): number;
declare function wvTickStop(h: number): number;
declare function wvFsRead(h: number, path: string): number;
declare function wvFsWrite(h: number, path: string, data: string): number;
declare function wvFsStatus(h: number, id: number): number;
declare function wvFsLen(h: number, id: number): number;
declare function wvFsByte(h: number, id: number, i: number): number;
declare function wvFsFree(h: number, id: number): number;

const FS_PENDING = 0;
const FS_OK = 1;

// Bind index the shim uses for a timer tick rather than a page invoke.
const TICK_BIND = 4294967295;

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

// Handlers receive the invoke args as JSON text and must return JSON text
// (what the frontend promise resolves with). Throwing is not supported by
// scriptc across the FFI boundary — return an error envelope instead.
export type CommandHandler = (argsJson: string) => string;

/**
 * An async command: return immediately, answer later. `resolve`/`reject` take
 * JSON text and settle the page's `await janela.invoke(...)` promise whenever
 * they are called — from a later defer()/sleep() turn, or from another
 * command. The window stays responsive for as long as the call is pending.
 */
export type AsyncCommandHandler = (
  argsJson: string,
  resolve: (json: string) => void,
  reject: (json: string) => void,
) => void;

/**
 * Completion of an async file operation. `err` is null on success; on failure
 * it carries a Node-shaped message ("ENOENT: no such file or directory, open
 * '/x'") and `text` is empty. Errors arrive as values, never as throws —
 * scriptc cannot propagate an exception across the FFI boundary.
 */
export type FsCallback = (err: string | null, text: string) => void;

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
  /** Fire an event into the page; payloadJson must be valid JSON text. */
  emit: (event: string, payloadJson: string) => void;
  /** Close the window and make run() return. */
  quit: () => void;
  /** Show the page and block until the window closes. Returns the run status. */
  run: (html: string) => number;
}

const HEX = "0123456789abcdef";

function uEscape(unit: number): string {
  return (
    "\\u" +
    HEX.charAt((unit >> 12) & 0xf) +
    HEX.charAt((unit >> 8) & 0xf) +
    HEX.charAt((unit >> 4) & 0xf) +
    HEX.charAt(unit & 0xf)
  );
}

// The request arrives as UTF-8 JSON bytes. scriptc strings cannot hold lone
// surrogates (String.fromCharCode(0xd83d) yields a replacement char), so we
// never build non-ASCII chars directly: every code point >= 0x80 is re-emitted
// as a JSON \uXXXX escape (a surrogate PAIR of escapes for astral planes),
// which JSON.parse reconstructs correctly. Legal only because the payload is
// always JSON, where non-ASCII can only occur inside strings.
// Builds with push+join for the same reason drainJob does: `out = out + c` is
// quadratic in scriptc, which a large invoke payload would feel.
function readRequest(h: number): string {
  const out: string[] = [];
  const n = wvReqLen(h) + 0;
  let i = 0;
  while (i < n) {
    const b0 = wvReqByte(h, i) + 0;
    i = i + 1;
    let cp = b0;
    if ((b0 & 0xe0) === 0xc0 && i < n) {
      cp = ((b0 & 0x1f) << 6) | (wvReqByte(h, i) & 0x3f);
      i = i + 1;
    } else if ((b0 & 0xf0) === 0xe0 && i + 1 < n) {
      cp = ((b0 & 0x0f) << 12) | ((wvReqByte(h, i) & 0x3f) << 6) | (wvReqByte(h, i + 1) & 0x3f);
      i = i + 2;
    } else if ((b0 & 0xf8) === 0xf0 && i + 2 < n) {
      cp =
        ((b0 & 0x07) << 18) |
        ((wvReqByte(h, i) & 0x3f) << 12) |
        ((wvReqByte(h, i + 1) & 0x3f) << 6) |
        (wvReqByte(h, i + 2) & 0x3f);
      i = i + 3;
    }
    if (cp < 0x80) {
      out.push(String.fromCharCode(cp));
    } else if (cp < 0x10000) {
      out.push(uEscape(cp));
    } else {
      const v = cp - 0x10000;
      out.push(uEscape(0xd800 + (v >> 10)));
      out.push(uEscape(0xdc00 + (v & 0x3ff)));
    }
  }
  return out.join("");
}

// The reply must be valid JSON when it reaches the page. Non-ASCII chars can
// only legally occur inside JSON strings, where a \uXXXX escape is always
// equivalent — so escaping every char >127 keeps the byte channel ASCII-clean
// (surrogate halves escape individually, which JSON also permits).
function writeReply(h: number, body: string): void {
  wvReplyReset(h);
  for (let i = 0; i < body.length; i++) {
    const c = body.charCodeAt(i);
    if (c < 0x80) {
      wvReplyPush(h, c);
    } else {
      wvReplyPush(h, 92); // backslash
      wvReplyPush(h, 117); // 'u'
      wvReplyPush(h, HEX.charCodeAt((c >> 12) & 0xf));
      wvReplyPush(h, HEX.charCodeAt((c >> 8) & 0xf));
      wvReplyPush(h, HEX.charCodeAt((c >> 4) & 0xf));
      wvReplyPush(h, HEX.charCodeAt(c & 0xf));
    }
  }
}

// Drain a finished fs job into a TS string. The bytes are arbitrary UTF-8, and
// scriptc cannot build a lone surrogate with fromCharCode, so the bytes are
// re-emitted as a JSON string literal (\uXXXX, surrogate PAIRS for astral
// planes) and parsed once — JSON.parse is the only reliable way to reassemble
// an astral character here. Same reason readRequest escapes rather than builds.
// PERFORMANCE: parts.push(...) + join(), never `s = s + c` in a loop.
// Repeated concatenation is QUADRATIC in scriptc 0.0.32 — measured 449ms for
// 200k single-char appends versus 2ms for push+join. On a 1 MB file that is
// the difference between 12 seconds and a fifth of a second.
function drainJob(h: number, id: number): string {
  const n = wvFsLen(h, id) + 0;
  if (n <= 0) return "";
  const parts: string[] = [];
  let i = 0;
  while (i < n) {
    const b0 = wvFsByte(h, id, i) + 0;
    i = i + 1;
    if (b0 < 0x80) {
      // JSON forbids a raw " \ or control char inside a string literal.
      if (b0 === 34) {
        parts.push('\\"');
      } else if (b0 === 92) {
        parts.push("\\\\");
      } else if (b0 < 0x20) {
        parts.push(uEscape(b0));
      } else {
        parts.push(String.fromCharCode(b0));
      }
      continue;
    }
    let cp = b0;
    if ((b0 & 0xe0) === 0xc0 && i < n) {
      cp = ((b0 & 0x1f) << 6) | (wvFsByte(h, id, i) & 0x3f);
      i = i + 1;
    } else if ((b0 & 0xf0) === 0xe0 && i + 1 < n) {
      cp =
        ((b0 & 0x0f) << 12) |
        ((wvFsByte(h, id, i) & 0x3f) << 6) |
        (wvFsByte(h, id, i + 1) & 0x3f);
      i = i + 2;
    } else if ((b0 & 0xf8) === 0xf0 && i + 2 < n) {
      cp =
        ((b0 & 0x07) << 18) |
        ((wvFsByte(h, id, i) & 0x3f) << 12) |
        ((wvFsByte(h, id, i + 1) & 0x3f) << 6) |
        (wvFsByte(h, id, i + 2) & 0x3f);
      i = i + 3;
    }
    if (cp < 0x10000) {
      parts.push(uEscape(cp));
    } else {
      const v = cp - 0x10000;
      parts.push(uEscape(0xd800 + (v >> 10)));
      parts.push(uEscape(0xdc00 + (v & 0x3ff)));
    }
  }
  return JSON.parse('"' + parts.join("") + '"') as string;
}

export function createApp(cfg: WindowConfig): JanelaApp {
  const h = wvCreate(0) + 0;
  wvSetTitle(h, cfg.title);
  wvSetSize(h, cfg.width, cfg.height, 0);
  wvInit(h, BOOTSTRAP);

  // ---- the host loop -------------------------------------------------------
  // scriptc's event loop is parked for as long as the program sits inside the
  // wvRun() FFI call, so setTimeout/await never fire while the window is open.
  // These queues are drained instead by TICK_BIND callbacks that the shim's
  // ticker posts to the UI thread, and the ticker only runs while there is
  // work — an idle app costs nothing.
  const asyncNames: string[] = [];
  const asyncHandlers: AsyncCommandHandler[] = [];
  let taskFns: (() => void)[] = [];
  let timerFns: (() => void)[] = [];
  let timerDue: number[] = [];
  let fsIds: number[] = [];
  let fsCbs: FsCallback[] = [];
  let ticking = false;

  const wake = (): void => {
    if (ticking) return;
    ticking = true;
    wvTickStart(h, 8);
  };

  const idle = (): void => {
    if (!ticking) return;
    if (taskFns.length > 0 || timerFns.length > 0 || fsIds.length > 0) return;
    ticking = false;
    wvTickStop(h);
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
    if (fsIds.length > 0) {
      const keptIds: number[] = [];
      const keptCbs: FsCallback[] = [];
      const doneIds: number[] = [];
      const doneCbs: FsCallback[] = [];
      const doneOk: boolean[] = [];
      for (let i = 0; i < fsIds.length; i++) {
        const st = wvFsStatus(h, fsIds[i]) + 0;
        if (st === FS_PENDING) {
          keptIds.push(fsIds[i]);
          keptCbs.push(fsCbs[i]);
        } else {
          doneIds.push(fsIds[i]);
          doneCbs.push(fsCbs[i]);
          doneOk.push(st === FS_OK);
        }
      }
      fsIds = keptIds;
      fsCbs = keptCbs;
      for (let i = 0; i < doneIds.length; i++) {
        // On failure the payload IS the error message, so one drain serves
        // both outcomes.
        const payload = drainJob(h, doneIds[i]);
        wvFsFree(h, doneIds[i]);
        if (doneOk[i]) {
          doneCbs[i](null, payload);
        } else {
          doneCbs[i](payload, "");
        }
      }
    }
    idle();
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
      fsIds.push(id);
      fsCbs.push(cb);
      wake();
    },

    writeFileAsync: (path, data, cb) => {
      const id = wvFsWrite(h, path, data) + 0;
      if (id < 0) {
        app.defer(() => cb("EAGAIN: could not start a write of '" + path + "'"));
        return;
      }
      fsIds.push(id);
      // The write payload is empty on success; the shared callback shape just
      // ignores the text argument.
      fsCbs.push((err, _text) => cb(err));
      wake();
    },

    emit: (event, payloadJson) => {
      wvEval(
        h,
        "window.__wvEmit(" + JSON.stringify(event) + "," + payloadJson + ");",
      );
    },

    quit: () => {
      wvTerminate(h);
    },

    run: (html) => {
      const INVOKE = wvBind(h, "__invoke") + 0;
      wvSetHtml(h, html);

      const rc = wvRun(h, (bindIndex, _seq) => {
        // A tick is not an invoke: nothing is waiting on a reply, so the
        // shim never calls webview_return for it.
        if (bindIndex === TICK_BIND) {
          turn();
          return 0;
        }
        if (bindIndex !== INVOKE) {
          writeReply(h, '"unknown binding"');
          return 1;
        }
        const env = JSON.parse(readRequest(h)) as string[];
        const cmd = env[0];
        const argsJson = env[1];
        for (let i = 0; i < app.names.length; i++) {
          if (app.names[i] === cmd) {
            writeReply(h, app.handlers[i](argsJson));
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
              writeReply(h, JSON.stringify("cannot defer command: " + cmd));
              return 1;
            }
            const settle = (status: number): ((json: string) => void) => {
              let done = false;
              return (json: string) => {
                if (done) return; // a promise settles once
                done = true;
                writeReply(h, json);
                wvResolve(h, id, status);
              };
            };
            asyncHandlers[i](argsJson, settle(0), settle(1));
            return 0;
          }
        }
        writeReply(h, JSON.stringify("unknown command: " + cmd));
        return 1; // rejects the frontend promise
      }) + 0;
      return rc;
    },
  };
  return app;
}
