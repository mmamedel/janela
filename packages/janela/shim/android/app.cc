// janela's Android shell.
//
// Android owns the run loop and the app's TypeScript is a linked scriptc
// library we call into — the same shape as the iOS shell, and the mirror image
// of the desktop shim where TypeScript owns main() and drives a C library over
// FFI.
//
// Everything webview-shaped lives behind webview.h's Android backend: creating
// the web view, injecting the page bootstrap, binding the invoke channel,
// evaluating JavaScript, and settling a page promise that was answered later.
// What is left here is janela's own: the due-ordered timer queue, the table of
// page replies we are holding, file I/O, and the scriptc library's C ABI.
//
// scriptc builds Android as a library only, and library mode links no event
// loop (SC4005) and creates no threads, so the shell owns the clock and every
// blocking call. Unlike iOS there is no dispatch_after here, so the timer
// queue is a condvar thread that hands due work to the UI thread through the
// backend's dispatch() — the same design the desktop shim uses.

#include "webview.h"

#include <jni.h>

#include <algorithm>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <map>
#include <mutex>
#include <queue>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#include <android/log.h>

#define JANELA_LOG(...)                                                        \
  __android_log_print(ANDROID_LOG_INFO, "janela", __VA_ARGS__)

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
std::string g_files_dir; // the app's private storage, resolved at startup

/// Copy a library-owned result out of its arena and release it. Results live
/// until the next jl_reset(), so nothing may hold the pointer past this call.
std::string take_result(char *out, size_t out_len) {
  std::string s = out ? std::string(out, out_len) : std::string{"null"};
  jl_reset();
  return s;
}

void panic_sink(void *, const char *sym, size_t sym_len, const char *msg,
                size_t msg_len) {
  JANELA_LOG("host panic in %.*s: %.*s", (int)sym_len, sym, (int)msg_len, msg);
}

// ---- what the shell owns for the library ----------------------------------
//
// THE RULE (upstream scriptc #263): a channel handler must never re-enter the
// library. Every handler below only records what it was told and returns; the
// re-entry happens from work dispatched to the UI thread, i.e. at the top of a
// later turn with no library frame beneath it. A breach silently appears to
// work, so this has to hold by construction rather than by testing.

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

// ---- the timer queue -------------------------------------------------------
//
// A due-ordered queue plus one thread that only ever sleeps and hands work to
// the UI thread. The library never holds a timer; the shell owns the clock.

using clock_type = std::chrono::steady_clock;

struct timer_entry {
  clock_type::time_point due;
  double id;
  bool operator>(const timer_entry &other) const { return due > other.due; }
};

std::mutex g_timer_mutex;
std::condition_variable g_timer_cv;
std::priority_queue<timer_entry, std::vector<timer_entry>,
                    std::greater<timer_entry>>
    g_timers;
bool g_timer_stop = false;

void timer_thread() {
  std::unique_lock<std::mutex> lock{g_timer_mutex};
  while (!g_timer_stop) {
    if (g_timers.empty()) {
      g_timer_cv.wait(lock);
      continue;
    }
    auto next = g_timers.top();
    if (clock_type::now() < next.due) {
      g_timer_cv.wait_until(lock, next.due);
      continue;
    }
    g_timers.pop();
    lock.unlock();
    // Take the id BY VALUE into the lambda: anything captured by reference
    // here would be gone by the time the UI thread ran it.
    double id = next.id;
    if (g_webview) {
      g_webview->dispatch([id] {
        jl_on_timer(id); // fresh turn: no library frame beneath us
      });
    }
    lock.lock();
  }
}

/// Park a continuation with us and call back when it comes due. A zero delay
/// still goes through the queue and is handed straight to the UI thread — that
/// is app.defer(), and it costs no timer.
void host_schedule(void *, double id, double ms) {
  auto delay = std::chrono::milliseconds((long long)(ms > 0 ? ms : 0));
  {
    std::lock_guard<std::mutex> lock{g_timer_mutex};
    g_timers.push(timer_entry{clock_type::now() + delay, id});
  }
  g_timer_cv.notify_all();
}

/// The library has an answer for a held page reply.
void host_settle(void *, double pending_id, const char *env, size_t env_len) {
  auto key = (long long)pending_id;
  std::string envelope(env ? env : "null", env ? env_len : 4);
  if (g_webview) {
    g_webview->dispatch(
        [key, envelope] { resolve_pending(key, envelope); });
  }
}

// ---- the file queue --------------------------------------------------------
//
// Blocking I/O happens on its own thread, never on the UI thread and never
// inside the library, which links no threads of its own.
//
// An Android app has no useful working directory and cannot see host paths, so
// a relative path is taken as relative to the app's private files directory —
// the one place a sandboxed app can freely read and write.
std::string resolve_path(const std::string &path) {
  if (!path.empty() && path[0] == '/') {
    return path;
  }
  std::string base = g_files_dir.empty() ? std::string{"."} : g_files_dir;
  return base + "/" + path;
}

// Takes the payload BY VALUE: a lambda capturing a reference parameter
// captures the reference, so a temporary passed by the caller would already be
// destroyed by the time the UI thread ran it, and the library would decode
// freed memory. This exact trap has bitten twice on iOS.
void finish_fs(double id, bool ok, std::string payload) {
  if (g_webview) {
    g_webview->dispatch([id, ok, payload] {
      jl_on_fs_done(id, ok, payload.c_str(), payload.size());
    });
  }
}

void host_read_file(void *, double id, const char *path, size_t path_len) {
  std::string p = resolve_path(std::string(path, path_len));
  std::thread([id, p] {
    std::ifstream in(p, std::ios::binary);
    if (!in) {
      finish_fs(id, false,
                "ENOENT: no such file or directory, open '" + p + "'");
      return;
    }
    std::ostringstream ss;
    ss << in.rdbuf();
    finish_fs(id, true, ss.str());
  }).detach();
}

void host_write_file(void *, double id, const char *path, size_t path_len,
                     const char *data, size_t data_len) {
  std::string p = resolve_path(std::string(path, path_len));
  std::string d(data, data_len);
  std::thread([id, p, d] {
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
  }).detach();
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
  if (g_webview) {
    g_webview->eval(js); // the backend posts this to the UI thread itself
  }
}

// ---- the page-side bridge --------------------------------------------------
//
// webview.h binds __janelaInvoke and injects the plumbing that turns it into a
// promise; this adds the janela surface on top, so `janela/api` and a
// project's frontend work exactly as they do on desktop and iOS.

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

/// Ask the Activity where this app may write. There is no HOME on Android.
std::string files_dir(JNIEnv *env, jobject activity) {
  jclass cls = env->GetObjectClass(activity);
  jmethodID mid = env->GetMethodID(cls, "getFilesDir", "()Ljava/io/File;");
  if (!mid) {
    env->ExceptionClear();
    return {};
  }
  jobject file = env->CallObjectMethod(activity, mid);
  if (!file) {
    env->ExceptionClear();
    return {};
  }
  jclass file_cls = env->GetObjectClass(file);
  jmethodID path_mid =
      env->GetMethodID(file_cls, "getAbsolutePath", "()Ljava/lang/String;");
  auto jpath = static_cast<jstring>(env->CallObjectMethod(file, path_mid));
  std::string out;
  if (jpath) {
    const char *chars = env->GetStringUTFChars(jpath, nullptr);
    if (chars) {
      out = chars;
      env->ReleaseStringUTFChars(jpath, chars);
    }
    env->DeleteLocalRef(jpath);
  }
  env->DeleteLocalRef(file_cls);
  env->DeleteLocalRef(file);
  env->DeleteLocalRef(cls);
  return out;
}

JavaVM *g_vm = nullptr;

} // namespace

extern "C" JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM *vm, void *) {
  g_vm = vm;
  return JNI_VERSION_1_6;
}

extern "C" JNIEXPORT void JNICALL
Java_dev_janela_host_JanelaActivity_nativeOnCreate(JNIEnv *env, jclass,
                                                   jobject activity) {
  if (!webview::android::attach(g_vm, env, activity)) {
    JANELA_LOG("could not attach the webview bridge");
    return;
  }
  g_files_dir = files_dir(env, activity);

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
    JANELA_LOG("could not register a host channel");
  }
  jl_init();

  // Heap-allocated and never freed: the web view outlives this call, and the
  // Activity's lifetime is the app's.
  auto *w = new webview::webview(false, nullptr);
  g_webview = w;
  w->init(kBootstrap);
  w->bind("__janelaInvoke", on_invoke, nullptr);

  static std::thread timers{timer_thread};
  timers.detach();

  char *out = nullptr;
  size_t out_len = 0;
  jl_index_html(&out, &out_len);
  w->set_html(take_result(out, out_len));

  w->run(); // returns immediately: Android already owns the loop
}
