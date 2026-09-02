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
#include <os/log.h>
#include <sys/stat.h>
#include <unistd.h>

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <map>
#include <sstream>
#include <string>
#include <vector>

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
void jl_on_dialog_done(double id, bool ok, const char *payload,
                       size_t payload_len);
}

namespace {

webview::webview *g_webview = nullptr;

// ---- logging ---------------------------------------------------------------
//
// scriptc's console.log writes to stdout. On a desktop that is where a
// developer is looking; on iOS nobody is, because the unified log is what
// `log show`, `log stream` and Console.app read, and it is the only channel
// `xcrun simctl` can surface. Screenshotting the page to find out what the
// host printed is not a debugging story.
//
// So the shell tees the library's stdout and stderr into os_log, line by line,
// under a stable subsystem and category so they can be filtered:
//
//   xcrun simctl spawn booted log stream --predicate \
//     'subsystem == "dev.janela"'
//
// The original descriptors are kept and still written, so a run attached to a
// terminal prints exactly as before — the tee adds a destination, it does not
// move one.

os_log_t janela_log() {
  static os_log_t log = os_log_create("dev.janela", "host");
  return log;
}

/// Replace `fd` with a pipe, forwarding every line to os_log and on to the
/// original descriptor. One reader queue per fd; the shell may create threads
/// even though the library may not.
void tee_fd_to_oslog(int fd, os_log_type_t type, const char *label) {
  int original = dup(fd);
  if (original < 0) {
    return;
  }
  int fds[2];
  if (pipe(fds) != 0) {
    close(original);
    return;
  }
  if (dup2(fds[1], fd) < 0) {
    close(fds[0]);
    close(fds[1]);
    close(original);
    return;
  }
  close(fds[1]);

  int read_fd = fds[0];
  // A pipe is not a tty, so stdio would switch to full buffering and hold the
  // library's output until the buffer filled or the process exited. Neither is
  // acceptable for a log, so pin line buffering back on.
  if (fd == STDOUT_FILENO) {
    setvbuf(stdout, nullptr, _IOLBF, 0);
  } else if (fd == STDERR_FILENO) {
    setvbuf(stderr, nullptr, _IOLBF, 0);
  }

  dispatch_queue_t q = dispatch_queue_create("dev.janela.log", DISPATCH_QUEUE_SERIAL);
  dispatch_async(q, ^{
    std::string pending;
    std::vector<char> buf(4096);
    for (;;) {
      ssize_t n = read(read_fd, buf.data(), buf.size());
      if (n <= 0) {
        break; // writer closed, or an unrecoverable error
      }
      // Pass the bytes through untouched first: stdout must behave as before.
      ssize_t off = 0;
      while (off < n) {
        ssize_t w = write(original, buf.data() + off, (size_t)(n - off));
        if (w <= 0) {
          break;
        }
        off += w;
      }
      // Then split into lines for the unified log, which is line-oriented.
      // %{public}s is required: os_log redacts a plain %s as <private>.
      pending.append(buf.data(), (size_t)n);
      size_t nl;
      while ((nl = pending.find('\n')) != std::string::npos) {
        std::string line = pending.substr(0, nl);
        pending.erase(0, nl + 1);
        if (!line.empty() && line.back() == '\r') {
          line.pop_back();
        }
        if (!line.empty()) {
          os_log_with_type(janela_log(), type, "%{public}s", line.c_str());
        }
      }
      // A very long line with no newline would otherwise grow without bound.
      if (pending.size() > 64 * 1024) {
        os_log_with_type(janela_log(), type, "%{public}s", pending.c_str());
        pending.clear();
      }
    }
    if (!pending.empty()) {
      os_log_with_type(janela_log(), type, "%{public}s", pending.c_str());
    }
  });
  os_log_with_type(janela_log(), OS_LOG_TYPE_INFO,
                   "janela: %{public}s is mirrored to the unified log", label);
}

/// Mirror the library's output into the unified log. Called before jl_init(),
/// so anything setup() prints is already captured.
void start_logging() {
  tee_fd_to_oslog(STDOUT_FILENO, OS_LOG_TYPE_DEFAULT, "stdout");
  tee_fd_to_oslog(STDERR_FILENO, OS_LOG_TYPE_ERROR, "stderr");
}

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
    // A directory opens cleanly as an ifstream on Apple platforms and then
    // reads as empty, so without this check readFileAsync would report
    // success with no content. Desktop already answers EISDIR here; the
    // message is kept identical so app code can treat the platforms alike.
    struct stat st;
    if (::stat(p.c_str(), &st) == 0 && S_ISDIR(st.st_mode)) {
      finish_fs(id, false,
                "EISDIR: illegal operation on a directory, read '" + p + "'");
      return;
    }
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

// ---- the document picker ---------------------------------------------------
//
// A picked file cannot simply be handed to readFileAsync. iOS returns a
// security-scoped URL: readable only between startAccessingSecurityScopedResource
// and its counterpart, and not readable at all after a relaunch without a
// bookmark. So the shell copies the file into the app's container while the
// scope is held and hands back that path, which readFileAsync can already
// open. The copy is a snapshot; nothing tracks the original afterwards.

std::string js_quote(const std::string &raw); // defined with the event channel

namespace objc = webview::detail::objc;

id ns_string(const std::string &s) {
  return objc::msg_send<id>(objc::get_class("NSString"),
                            objc::selector("stringWithUTF8String:"), s.c_str());
}

std::string from_ns_string(id s) {
  if (!s) {
    return {};
  }
  const char *c = objc::msg_send<const char *>(s, objc::selector("UTF8String"));
  return c ? std::string(c) : std::string{};
}

/// Extension -> uniform type identifier.
///
/// UIDocumentPickerViewController wants UTIs, and turning an arbitrary
/// extension into one needs UniformTypeIdentifiers or CoreServices. Rather
/// than link a framework for a lookup table, this covers the common cases; an
/// extension that is not here widens the picker to public.item and says so in
/// the log, so a filter is never silently dropped.
const char *uti_for_extension(const std::string &ext) {
  static const std::map<std::string, const char *> kUtis = {
      {"txt", "public.plain-text"},   {"text", "public.plain-text"},
      {"md", "net.daringfireball.markdown"},
      {"json", "public.json"},        {"csv", "public.comma-separated-values-text"},
      {"xml", "public.xml"},          {"html", "public.html"},
      {"htm", "public.html"},         {"pdf", "com.adobe.pdf"},
      {"png", "public.png"},          {"jpg", "public.jpeg"},
      {"jpeg", "public.jpeg"},        {"gif", "com.compuserve.gif"},
      {"heic", "public.heic"},        {"mp3", "public.mp3"},
      {"wav", "com.microsoft.waveform-audio"},
      {"mp4", "public.mpeg-4"},       {"mov", "com.apple.quicktime-movie"},
      {"zip", "public.zip-archive"},  {"js", "com.netscape.javascript-source"},
      {"ts", "public.plain-text"},    {"css", "public.css"},
      {"yaml", "public.yaml"},        {"yml", "public.yaml"},
  };
  auto it = kUtis.find(ext);
  return it == kUtis.end() ? nullptr : it->second;
}

std::string lower(std::string s) {
  for (char &c : s) {
    if (c >= 'A' && c <= 'Z') {
      c = (char)(c - 'A' + 'a');
    }
  }
  return s;
}

/// Copy a picked file into the app's container, returning the new path.
/// Called with the security scope already held.
std::string copy_into_container(const std::string &src) {
  std::string name = src;
  size_t slash = name.find_last_of('/');
  if (slash != std::string::npos) {
    name = name.substr(slash + 1);
  }
  if (name.empty()) {
    name = "picked";
  }
  std::string dest = resolve_path("picked/" + name);
  size_t cut = dest.find_last_of('/');
  if (cut != std::string::npos) {
    // The pick directory may not exist yet; mkdir -p one level is enough.
    std::string dir = dest.substr(0, cut);
    ::mkdir(dir.c_str(), 0755);
  }
  std::ifstream in(src, std::ios::binary);
  if (!in) {
    return {};
  }
  std::ofstream out(dest, std::ios::binary | std::ios::trunc);
  if (!out) {
    return {};
  }
  out << in.rdbuf();
  out.close();
  return out ? dest : std::string{};
}

/// The dialog job the picker delegate answers. Only ever touched on the main
/// queue, where UIKit presents and dismisses.
double g_dialog_id = 0;
bool g_dialog_open = false;

void finish_dialog(double id, bool ok, std::string payload) {
  // BY VALUE, and dispatched: never re-enter the library from inside a UIKit
  // callback (upstream #263) — this lands at the top of a later turn.
  dispatch_async(dispatch_get_main_queue(), ^{
    g_dialog_open = false;
    jl_on_dialog_done(id, ok, payload.c_str(), payload.size());
  });
}

/// Turn the picked URLs into a JSON array of container paths.
void deliver_picked(id urls) {
  double id_ = g_dialog_id;
  if (!urls) {
    finish_dialog(id_, true, "[]");
    return;
  }
  auto count = objc::msg_send<unsigned long>(urls, objc::selector("count"));
  std::string json = "[";
  for (unsigned long i = 0; i < count; i++) {
    id url = objc::msg_send<id>(urls, objc::selector("objectAtIndex:"), i);
    if (!url) {
      continue;
    }
    // The scope must be held across the copy, and released even on failure.
    bool scoped = objc::msg_send<bool>(
        url, objc::selector("startAccessingSecurityScopedResource"));
    std::string path =
        from_ns_string(objc::msg_send<id>(url, objc::selector("path")));
    std::string copied = copy_into_container(path);
    if (scoped) {
      objc::msg_send<void>(url,
                           objc::selector("stopAccessingSecurityScopedResource"));
    }
    if (copied.empty()) {
      finish_dialog(id_, false,
                    "EIO: could not copy the picked file into the app's "
                    "container ('" + path + "')");
      return;
    }
    if (json.size() > 1) {
      json += ",";
    }
    json += js_quote(copied);
  }
  json += "]";
  finish_dialog(id_, true, json);
}

/// The picker's delegate, built at runtime.
///
/// UIKit needs a real Objective-C class to send the delegate messages to, and
/// this shell is plain C++, so the class is registered once with the runtime
/// and its two methods are plain C functions. One shared instance is enough:
/// only one picker can be up at a time, which g_dialog_open enforces.
Class picker_delegate_class() {
  static Class cls = nullptr;
  if (cls) {
    return cls;
  }
  cls = objc_allocateClassPair(objc::get_class("NSObject"),
                               "JanelaPickerDelegate", 0);
  class_addMethod(
      cls, objc::selector("documentPicker:didPickDocumentsAtURLs:"),
      (IMP)(+[](id, SEL, id, id urls) { deliver_picked(urls); }), "v@:@@");
  class_addMethod(cls, objc::selector("documentPickerWasCancelled:"),
                  (IMP)(+[](id, SEL, id) {
                    // Cancel is not an error: an empty list becomes null.
                    finish_dialog(g_dialog_id, true, "[]");
                  }),
                  "v@:@");
  objc_registerClassPair(cls);
  return cls;
}

id picker_delegate() {
  static id instance = objc::msg_send<id>(
      objc::msg_send<id>((id)picker_delegate_class(), objc::selector("alloc")),
      objc::selector("init"));
  return instance;
}

/// TS -> shell: present a document picker. Records the request and returns;
/// UIKit work happens on the main queue, never inside this handler.
void host_open_dialog(void *, double job, const char *options, size_t len) {
  std::string opts(options, len);
  dispatch_async(dispatch_get_main_queue(), ^{
    if (g_dialog_open) {
      finish_dialog(job, false,
                    "EBUSY: a file dialog is already open on this app");
      return;
    }

    // `directory` has no picker on iOS; report rather than quietly opening a
    // file picker instead, which is what desktop does for unsupported options.
    if (webview::detail::json_parse(opts, "directory", 0) == "true") {
      finish_dialog(job, false,
                    "ENOTSUP: picking a directory is not supported on iOS");
      return;
    }

    // Build the UTI list from the filters' extensions. An unmapped extension
    // widens to public.item and is logged, so a filter is never silently lost.
    id types = objc::msg_send<id>(objc::get_class("NSMutableArray"),
                                  objc::selector("array"));
    bool widened = false;
    for (size_t i = 0;; i++) {
      std::string ext = webview::detail::json_parse(opts, "extensions", i);
      if (ext.empty()) {
        break;
      }
      const char *uti = uti_for_extension(lower(ext));
      if (uti) {
        objc::msg_send<void>(types, objc::selector("addObject:"),
                             ns_string(uti));
      } else if (!widened) {
        widened = true;
        std::fprintf(stderr,
                     "[janela] no uniform type identifier is mapped for '.%s', "
                     "so the picker is not filtered\n",
                     ext.c_str());
      }
    }
    auto count = objc::msg_send<unsigned long>(types, objc::selector("count"));
    if (count == 0 || widened) {
      objc::msg_send<void>(types, objc::selector("addObject:"),
                           ns_string("public.item"));
    }

    // initWithDocumentTypes:inMode: rather than the UTType-based initialiser,
    // which would mean linking UniformTypeIdentifiers for a lookup table.
    id picker = objc::msg_send<id>(
        objc::msg_send<id>(
            objc::get_class("UIDocumentPickerViewController"),
            objc::selector("alloc")),
        objc::selector("initWithDocumentTypes:inMode:"), types,
        (unsigned long)0 /* UIDocumentPickerModeImport: hands us a copy */);
    if (!picker) {
      finish_dialog(job, false, "EIO: could not create a document picker");
      return;
    }
    objc::msg_send<void>(picker, objc::selector("setDelegate:"),
                         picker_delegate());
    if (webview::detail::json_parse(opts, "multiple", 0) == "true") {
      objc::msg_send<void>(picker, objc::selector("setAllowsMultipleSelection:"),
                           true);
    }

    id window = nullptr;
    if (g_webview) {
      auto w = g_webview->window();
      if (w.ok()) {
        window = (id)w.value();
      }
    }
    id root = window ? objc::msg_send<id>(
                           window, objc::selector("rootViewController"))
                     : nullptr;
    if (!root) {
      finish_dialog(job, false,
                    "EINVAL: the app has no root view controller to present on");
      return;
    }

    g_dialog_id = job;
    g_dialog_open = true;
    objc::msg_send<void>(root,
                         objc::selector("presentViewController:animated:completion:"),
                         picker, true, nullptr);
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
  // Before anything else, so setup()'s own output is captured too.
  start_logging();

  // Registration is a pure store and is legal before init; the panic sink and
  // every channel must be in place before any TypeScript runs, since setup()
  // executes during jl_init().
  jl_set_panic_sink(panic_sink, nullptr);
  if (jl_set_callback("hostSchedule", (void (*)(void))host_schedule, nullptr) ||
      jl_set_callback("hostSettle", (void (*)(void))host_settle, nullptr) ||
      jl_set_callback("hostReadFile", (void (*)(void))host_read_file, nullptr) ||
      jl_set_callback("hostWriteFile", (void (*)(void))host_write_file,
                      nullptr) ||
      jl_set_callback("hostOpenDialog", (void (*)(void))host_open_dialog,
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
