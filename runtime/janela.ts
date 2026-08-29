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
function readRequest(h: number): string {
  let out = "";
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
      out = out + String.fromCharCode(cp);
    } else if (cp < 0x10000) {
      out = out + uEscape(cp);
    } else {
      const v = cp - 0x10000;
      out = out + uEscape(0xd800 + (v >> 10)) + uEscape(0xdc00 + (v & 0x3ff));
    }
  }
  return out;
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

export function createApp(cfg: WindowConfig): JanelaApp {
  const h = wvCreate(0) + 0;
  wvSetTitle(h, cfg.title);
  wvSetSize(h, cfg.width, cfg.height, 0);
  wvInit(h, BOOTSTRAP);

  const app: JanelaApp = {
    handle: h,
    names: [],
    handlers: [],

    command: (name, handler) => {
      app.names.push(name);
      app.handlers.push(handler);
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
        writeReply(h, JSON.stringify("unknown command: " + cmd));
        return 1; // rejects the frontend promise
      }) + 0;
      return rc;
    },
  };
  return app;
}
