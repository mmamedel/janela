// janela's iOS shell.
//
// UIKit owns the run loop and the app's TypeScript is a linked scriptc
// library we call into — the mirror image of the desktop shim, where
// TypeScript owns main() and drives a C library over FFI.
//
// Everything webview-shaped lives behind webview.h's UIKit backend: creating
// the web view, injecting the page bootstrap, binding the invoke channel,
// evaluating JavaScript, and settling a page promise that was answered later.
// What is left here is janela's own: the due-ordered timer queue, the table of
// page replies we are holding, file I/O, and the scriptc library's C ABI.
//
// scriptc builds iOS as a library only, and library mode links no event loop
// (SC4005) and creates no threads, so the shell owns the clock and every
// blocking call.

#include "webview.h"

#include <dispatch/dispatch.h>

#include <cstdlib>
#include <cstring>
#include <fstream>
#include <map>
#include <sstream>
#include <string>

// ---- the scriptc library's C ABI (see the generated profile) ---------------
extern "C" {
void jl_init(void);
void jl_reset(void);
void jl_set_panic_sink(void (*fn)(void *, const char *, size_t, const char *,
                                  size_t),
                       void *ctx);
int32_t jl_set_callback(const char *name, void (*fn)(void), void *ctx);
void jl_handle_invoke(const char *cmd, size_t cmd_len, const char *args,
                      size_t args_len, char **out, size_t *out_len);
void jl_index_html(char **out, size_t *out_len);
void jl_on_timer(double id);
void jl_on_fs_done(double id, bool ok, const char *payload, size_t payload_len);
}

namespace {

webview::webview *g_webview = nullptr;

/// Copy a library-owned result out of its arena and release it. Results live
/// until the next jl_reset(), so nothing may hold the pointer past this call.
std::string take_result(char *out, size_t out_len) {
  std::string s = out ? std::string(out, out_len) : std::string{"null"};
  jl_reset();
  return s;
}

void panic_sink(void *, const char *sym, size_t sym_len, const char *msg,
                size_t msg_len) {
  std::fprintf(stderr, "[janela] host panic in %.*s: %.*s\n", (int)sym_len, sym,
               (int)msg_len, msg);
}

// ---- what the shell owns for the library ----------------------------------
//
// THE RULE (upstream scriptc #263): a channel handler must never re-enter the
// library. Every handler below only records what it was told and returns; the
// re-entry happens from a dispatched block, i.e. at the top of a later turn
// with no library frame beneath it. A breach silently appears to work, so this
// has to hold by construction rather than by testing.

/// Page replies whose answer was not ready when handle_invoke returned:
/// janela's pending id -> the webview binding id we have not resolved yet.
std::map<long long, std::string> g_held;
/// Envelopes that arrived before we knew the binding id — a command that
/// resolves synchronously settles during its own dispatch, before the
/// {"pending":id} envelope has made it back to us.
std::map<long long, std::string> g_early;

void settle(const std::string &binding_id, const std::string &envelope) {
  if (g_webview) {
    g_webview->resolve(binding_id, 0, envelope);
  }
}

/// Answer the page for a pending id, whichever half arrived first.
void resolve_pending(long long pending_id, const std::string &envelope) {
  auto it = g_held.find(pending_id);
  if (it != g_held.end()) {
    std::string binding_id = it->second;
    g_held.erase(it);
    settle(binding_id, envelope);
  } else {
    g_early[pending_id] = envelope; // handle_invoke has not returned yet
  }
}

/// Register the binding id a pending answer belongs to.
void hold_pending(long long pending_id, const std::string &binding_id) {
  auto it = g_early.find(pending_id);
  if (it != g_early.end()) {
    std::string envelope = it->second;
    g_early.erase(it);
    settle(binding_id, envelope); // it resolved synchronously; answer now
  } else {
    g_held[pending_id] = binding_id;
  }
}

// ---- channels the library calls (TS -> shell) ------------------------------

/// Park a continuation with us and call back when it comes due. A zero delay
/// still goes through dispatch_after(0), which posts to the next turn — that
/// is app.defer(), and it costs no timer.
void host_schedule(void *, double id, double ms) {
  int64_t delay = (int64_t)(ms > 0 ? ms : 0);
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, delay * NSEC_PER_MSEC),
                 dispatch_get_main_queue(), ^{
                   jl_on_timer(id); // fresh turn: no library frame beneath us
                 });
}

/// The library has an answer for a held page reply.
void host_settle(void *, double pending_id, const char *env, size_t env_len) {
  auto key = (long long)pending_id;
  std::string envelope(env ? env : "null", env ? env_len : 4);
  dispatch_async(dispatch_get_main_queue(), ^{
    resolve_pending(key, envelope);
  });
}

// ---- the file queue --------------------------------------------------------
//
// Blocking I/O happens here, never on the main queue and never inside the
// library, which links no threads of its own.
//
// An iOS app has no useful working directory and cannot see host paths, so a
// relative path is taken as relative to the app's Documents directory — the
// one place a sandboxed app can freely read and write. HOME is the app's
// container, so this needs no Foundation call.
std::string resolve_path(const std::string &path) {
  if (!path.empty() && path[0] == '/') {
    return path;
  }
  const char *home = std::getenv("HOME");
  std::string base = home ? std::string(home) + "/Documents" : std::string(".");
  return base + "/" + path;
}

dispatch_queue_t fs_queue() {
  static dispatch_queue_t q =
      dispatch_queue_create("dev.janela.fs", DISPATCH_QUEUE_SERIAL);
  return q;
}

// Takes the payload BY VALUE: a block captures a reference parameter as a
// reference, so a temporary passed by the caller would already be destroyed by
// the time the block runs on the main queue, and the library would decode
// freed memory.
void finish_fs(double id, bool ok, std::string payload) {
  dispatch_async(dispatch_get_main_queue(), ^{
    jl_on_fs_done(id, ok, payload.c_str(), payload.size());
  });
}

void host_read_file(void *, double id, const char *path, size_t path_len) {
  std::string p = resolve_path(std::string(path, path_len));
  dispatch_async(fs_queue(), ^{
    std::ifstream in(p, std::ios::binary);
    if (!in) {
      finish_fs(id, false, "ENOENT: no such file or directory, open '" + p + "'");
      return;
    }
    std::ostringstream ss;
    ss << in.rdbuf();
    finish_fs(id, true, ss.str());
  });
}

void host_write_file(void *, double id, const char *path, size_t path_len,
                     const char *data, size_t data_len) {
  std::string p = resolve_path(std::string(path, path_len));
  std::string d(data, data_len);
  dispatch_async(fs_queue(), ^{
    std::ofstream out(p, std::ios::binary | std::ios::trunc);
    if (!out) {
      finish_fs(id, false, "EACCES: could not open '" + p + "' for writing");
      return;
    }
    out.write(d.data(), (std::streamsize)d.size());
    out.close();
    if (!out) {
      finish_fs(id, false, "EIO: write failed for '" + p + "'");
      return;
    }
    finish_fs(id, true, "");
  });
}

// ---- host -> page: the event channel ---------------------------------------

/// Minimal JSON string quoting, for splicing an event name into a JS call.
std::string js_quote(const std::string &raw) {
  std::string out = "\"";
  for (char c : raw) {
    switch (c) {
    case '"':
      out += "\\\"";
      break;
    case '\\':
      out += "\\\\";
      break;
    case '\n':
      out += "\\n";
      break;
    case '\r':
      out += "\\r";
      break;
    case '\t':
      out += "\\t";
      break;
    default:
      if ((unsigned char)c < 0x20) {
        char buf[7];
        std::snprintf(buf, sizeof(buf), "\\u%04x", c);
        out += buf;
      } else {
        out += c;
      }
    }
  }
  out += "\"";
  return out;
}

void emit_event(void *, const char *name, size_t name_len, const char *payload,
                size_t payload_len) {
  std::string js = "window.__wvEmit(" +
                   js_quote(std::string(name, name_len)) + "," +
                   std::string(payload, payload_len) + ");";
  dispatch_async(dispatch_get_main_queue(), ^{
    if (g_webview) {
      g_webview->eval(js);
    }
  });
}

// ---- the page-side bridge --------------------------------------------------
//
// webview.h binds __janelaInvoke and injects the plumbing that turns it into a
// promise; this adds the janela surface on top, so `janela/api` and a
// project's frontend work exactly as they do on desktop.

const char *const kBootstrap = R"JS(
window.__wvListeners = {};
window.janela = {
  invoke: function (cmd, args) {
    return window.__janelaInvoke(cmd, JSON.stringify(args === undefined ? null : args))
      .then(function (env) {
        if (env && env.ok) return env.value;
        throw new Error((env && env.error) || 'janela: invoke failed');
      });
  },
  listen: function (event, cb) {
    if (!window.__wvListeners[event]) window.__wvListeners[event] = [];
    window.__wvListeners[event].push(cb);
    return function () {
      var a = window.__wvListeners[event] || [];
      var i = a.indexOf(cb);
      if (i >= 0) a.splice(i, 1);
    };
  },
};
window.__wvEmit = function (event, payload) {
  var cbs = window.__wvListeners[event] || [];
  for (var i = 0; i < cbs.length; i++) cbs[i](payload);
};
)JS";

/// The page's invoke channel. `req` is a JSON array of the two arguments the
/// bootstrap passed: [cmd, argsJson].
void on_invoke(const std::string &binding_id, const std::string &req, void *) {
  std::string cmd = webview::detail::json_parse(req, "", 0);
  std::string args = webview::detail::json_parse(req, "", 1);

  char *out = nullptr;
  size_t out_len = 0;
  jl_handle_invoke(cmd.c_str(), cmd.size(), args.c_str(), args.size(), &out,
                   &out_len);
  std::string reply = take_result(out, out_len);

  // An async command answers later: the library returns {"pending":<id>} and
  // we hold the page's promise until host_settle() tells us what it is.
  std::string pending = webview::detail::json_parse(reply, "pending", 0);
  if (!pending.empty()) {
    hold_pending(std::strtoll(pending.c_str(), nullptr, 10), binding_id);
    return;
  }

  // Otherwise the reply is already the envelope the bootstrap expects.
  settle(binding_id, reply);
}

} // namespace

int main() {
  // Registration is a pure store and is legal before init; the panic sink and
  // every channel must be in place before any TypeScript runs, since setup()
  // executes during jl_init().
  jl_set_panic_sink(panic_sink, nullptr);
  if (jl_set_callback("hostSchedule", (void (*)(void))host_schedule, nullptr) ||
      jl_set_callback("hostSettle", (void (*)(void))host_settle, nullptr) ||
      jl_set_callback("hostReadFile", (void (*)(void))host_read_file, nullptr) ||
      jl_set_callback("hostWriteFile", (void (*)(void))host_write_file,
                      nullptr) ||
      jl_set_callback("janelaEmit", (void (*)(void))emit_event, nullptr)) {
    std::fprintf(stderr, "[janela] could not register a host channel\n");
  }
  jl_init();

  webview::webview w(false, nullptr);
  g_webview = &w;
  w.init(kBootstrap);
  w.bind("__janelaInvoke", on_invoke, nullptr);

  char *out = nullptr;
  size_t out_len = 0;
  jl_index_html(&out, &out_len);
  w.set_html(take_result(out, out_len));

  w.run(); // enters UIApplicationMain; does not return
  return 0;
}
