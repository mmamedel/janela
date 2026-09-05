// wvshim.cc — a C-ABI shim over webview.h shaped to scriptc's FFI format 4.
//
// One constraint still drives the design: scriptc has no pointer/u64 type, so
// webview_t can never cross the boundary. We keep a handle table and hand out
// int32 indices.
//
// What the newer formats removed:
//   * format 3 — callback params may be `string`/`bytes`, so a payload crosses
//     into TS as one argument instead of one FFI call per byte. Payloads going
//     the other way ride `string` params on ordinary functions.
//   * format 4 — callbacks may be `retained`, so the invoke and timer handlers
//     are registered once and live for the app's lifetime. wv_run() is a plain
//     blocking call again; it no longer has to carry a callback whose "call
//     scope" was standing in for "app lifetime".
//
// The shell owns scheduling. TS never holds a timer: it registers a
// continuation under an id and calls wv_schedule(), and this shim calls back
// into TS with that id once the delay is up. That is the same shape a library
// -mode host (iOS) must use, where the compiled TS links no event loop at all.

#include "webview.h"

#include <algorithm>
#include <atomic>
#include <cctype>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

// Native dialogs need each platform's own toolkit. webview.h has already
// pulled in the Cocoa bindings (via its own backend headers) and windows.h on
// Win32; these add only what it does not use itself.
#if defined(_WIN32)
#include <commdlg.h>
// ShellAboutW: the standard Windows About box, which is what `predefined.about`
// should show here for the same reason macOS shows NSApplication's.
#include <shellapi.h>
#elif !defined(__APPLE__)
#include <gtk/gtk.h>
// The editing actions (Copy, Paste, Undo) are WebKit's, not GTK's, and this is
// the only header that declares them. It costs nothing to include: the build
// already compiles and links against WebKitGTK for the backend itself.
//
// Which header depends on the GTK version, because webkit2gtk-4.1 IS the GTK 3
// build — the GTK 4 one is a different API version under a different name. The
// build pins gtk+-3.0 today; this split mirrors the vendored backend's own so
// that a GTK 4 attempt fails in the renderer, where the reason is written
// down, rather than on an include line.
#if GTK_MAJOR_VERSION >= 4
#include <webkit/webkit.h>
#else
#include <webkit2/webkit2.h>
#endif
#endif

namespace {

struct Bind {
  std::string name;
};

// An invoke whose webview_return was postponed by wv_defer(): the page's
// promise stays unsettled until TS calls wv_resolve() on a later turn.
struct Pending {
  bool used = false;
  std::string call_id;
};

// A continuation TS has parked with the shell: run whatever TS registered
// under `id` once `due` has passed. The shell owns the clock; TS owns the id.
struct Timer {
  int32_t id;
  std::chrono::steady_clock::time_point due;
};

struct App {
  webview_t w = nullptr;
  bool used = false;
  std::vector<Bind> binds;

  // Retained TS handlers, registered once and valid until the app exits. The
  // request rides in as a (ptr, len) string param.
  int32_t (*on_invoke)(const uint8_t *, size_t, void *) = nullptr;
  void *on_invoke_ctx = nullptr;
  void (*on_timer)(int32_t, void *) = nullptr;
  void *on_timer_ctx = nullptr;
  // The tag identifies the item; the host owns the numbering and hands it
  // down, because the click handler lives in TypeScript now.
  int32_t (*on_menu)(int32_t, void *) = nullptr;
  void *on_menu_ctx = nullptr;

  // Live NSMenuItems, indexed by tag, so setEnabled/setChecked/setLabel can
  // reach one without rebuilding the bar. Retained; released on the next
  // setMenu. The menu bar is process-global on macOS, so only one app can own
  // it — see g_menu_owner.
  //
  // `void *` rather than `id`: this struct is compiled on every platform and
  // `id` is Objective-C, so naming it here breaks the Linux and Windows
  // builds. The Apple code casts on the way in and out.
  std::vector<void *> menu_items;
  // Whether the host ever called setMenu. If it never does, wv_run installs
  // the whole standard bar, so an app that says nothing about menus still gets
  // Cmd+Q and Cmd+V.
  bool menu_set = false;

  // Staging for the in-flight request.
  std::string req;      // JSON args array from JS
  std::string cur_id;   // webview's call id, needed by webview_return
  std::string reply;    // response body handed over by TS in one call
  uint32_t seq = 0;

  // ---- async support ----
  // The held-reply table: an invoke whose answer is not ready yet. The page's
  // promise stays unsettled until wv_resolve() answers this call id.
  std::vector<Pending> pending;
  bool deferred = false;  // set by wv_defer() during the current call

  // The shell's timer queue, and the one thread that watches it. The thread
  // only sleeps and posts — it never touches TS, because scriptc's runtime is
  // not thread-safe. Everything reaches TS through webview_dispatch, on the UI
  // thread, on a LATER turn of the shell's own loop (see timer_on_ui_thread).
  std::vector<Timer> timers;
  std::mutex timers_mu;
  std::condition_variable timers_cv;
  std::thread scheduler;
  std::atomic<bool> scheduling{false};
};

// Reserved timer id: not a TS continuation but "a job changed state, service
// them". TS allocates its own continuation ids from 1 upwards.
const int32_t TIMER_JOBS = -1;

// Fixed-size table: handles are indices, never pointers.
App g_apps[8];

App *app_at(int32_t h) {
  if (h < 0 || h >= 8 || !g_apps[h].used) return nullptr;
  return &g_apps[h];
}

// scriptc passes strings as (ptr, len) and does NOT NUL-terminate.
std::string to_str(const uint8_t *p, size_t n) {
  return std::string(reinterpret_cast<const char *>(p), n);
}

// ---- jobs ------------------------------------------------------------------
//
// A job is any unit of work whose answer cannot be produced during the FFI
// call that asks for it. TS starts one and gets an id back immediately; when
// the job reaches a terminal state it posts TIMER_JOBS to the UI thread, and
// TS then reads wv_job_status() for the jobs it is waiting on.
//
// Two kinds use this pool, for opposite reasons:
//   * file I/O — the blocking syscall must happen off the UI thread, so a
//     worker thread does it. A worker touches only its own job and NEVER calls
//     into TS: scriptc's runtime is not thread-safe, so the result is drained
//     later, on the UI thread.
//   * native dialogs — the modal must run ON the UI thread, but not while TS
//     is on the stack (runModal/gtk_dialog_run spin a nested event loop, which
//     would re-enter TS underneath the invoke handler that asked for the
//     dialog). So the job is posted with webview_dispatch and runs at the top
//     of a later turn, with no TS frame beneath it.

const int32_t JOB_PENDING = 0;
const int32_t JOB_OK = 1;
const int32_t JOB_ERROR = 2;

struct Job {
  // Written by the producer (worker thread, or the dispatched dialog) before
  // `status` flips; read by the UI thread only after it observes a terminal
  // status. The release/acquire pair on `status` is what publishes `data`, so
  // no lock is needed for the payload itself.
  std::atomic<int32_t> status{JOB_PENDING};
  std::string data;  // payload on success, the error message on failure
  std::thread worker;  // unused by dialog jobs, which run on the UI thread
  bool used = false;
  // Which app to wake when this job finishes. Without the ticker there is
  // nothing polling, so a finished job has to announce itself.
  int32_t app = -1;
};

// Jobs are addressed by index and held behind unique_ptr so the vector may
// grow without invalidating a worker's pointer to its own job.
std::mutex g_jobs_mu;
std::vector<std::unique_ptr<Job>> g_jobs;

Job *job_at(int32_t id) {
  std::lock_guard<std::mutex> lock(g_jobs_mu);
  if (id < 0 || static_cast<size_t>(id) >= g_jobs.size()) return nullptr;
  Job *j = g_jobs[id].get();
  return j->used ? j : nullptr;
}

// Reuses a finished slot when one is free, so a long-running app that reads
// many files does not grow the table without bound.
int32_t new_job(int32_t app) {
  std::lock_guard<std::mutex> lock(g_jobs_mu);
  for (size_t i = 0; i < g_jobs.size(); i++) {
    if (g_jobs[i]->used) continue;
    if (g_jobs[i]->worker.joinable()) g_jobs[i]->worker.join();
    g_jobs[i]->status.store(JOB_PENDING);
    g_jobs[i]->data.clear();
    g_jobs[i]->used = true;
    g_jobs[i]->app = app;
    return static_cast<int32_t>(i);
  }
  g_jobs.push_back(std::unique_ptr<Job>(new Job()));
  g_jobs.back()->used = true;
  g_jobs.back()->app = app;
  return static_cast<int32_t>(g_jobs.size() - 1);
}

// Node-shaped messages: janela apps already surface node:fs errors from
// synchronous handlers, so the async path should read the same.
std::string fs_error_message(const std::string &path, const char *op) {
  std::error_code ec;
  auto st = std::filesystem::status(path, ec);
  if (st.type() == std::filesystem::file_type::not_found) {
    return "ENOENT: no such file or directory, " + std::string(op) + " '" +
           path + "'";
  }
  if (st.type() == std::filesystem::file_type::directory) {
    return "EISDIR: illegal operation on a directory, " + std::string(op) +
           " '" + path + "'";
  }
  return "EIO: failed to " + std::string(op) + " '" + path + "'";
}

// Defined below, once the app table is in scope. Posts `id` to the app's UI
// thread via webview_dispatch, so TS is entered on a later turn of the shell's
// own loop and never underneath a frame it is already inside.
void post_timer(int32_t app, int32_t id);

void job_finish(Job *j, int32_t status, std::string payload) {
  j->data = std::move(payload);
  j->status.store(status, std::memory_order_release);
  // Nothing polls any more, so a finished job announces itself. Safe from a
  // worker thread: webview_dispatch is the documented cross-thread hand-off,
  // and it only queues — TS runs later, on the UI thread.
  if (j->app >= 0) post_timer(j->app, TIMER_JOBS);
}

void fs_read_worker(Job *j, std::string path) {
  std::error_code ec;
  if (std::filesystem::is_directory(path, ec)) {
    job_finish(j, JOB_ERROR, fs_error_message(path, "read"));
    return;
  }
  std::ifstream in(path, std::ios::binary);
  if (!in) {
    job_finish(j, JOB_ERROR, fs_error_message(path, "open"));
    return;
  }
  std::string buf((std::istreambuf_iterator<char>(in)),
                  std::istreambuf_iterator<char>());
  if (in.bad()) {
    job_finish(j, JOB_ERROR, fs_error_message(path, "read"));
    return;
  }
  job_finish(j, JOB_OK, std::move(buf));
}

void fs_write_worker(Job *j, std::string path, std::string data) {
  std::ofstream out(path, std::ios::binary | std::ios::trunc);
  if (!out) {
    job_finish(j, JOB_ERROR, fs_error_message(path, "open"));
    return;
  }
  out.write(data.data(), static_cast<std::streamsize>(data.size()));
  out.flush();
  if (!out) {
    job_finish(j, JOB_ERROR, fs_error_message(path, "write"));
    return;
  }
  job_finish(j, JOB_OK, std::string());
}

// Join every worker. Called at shutdown so no thread outlives the process's
// orderly exit (and so nothing writes into a job after main returns).
void jobs_join_all() {
  std::lock_guard<std::mutex> lock(g_jobs_mu);
  for (size_t i = 0; i < g_jobs.size(); i++) {
    if (g_jobs[i]->worker.joinable()) g_jobs[i]->worker.join();
  }
}

// ---- native file dialogs ----------------------------------------------------
//
// Options arrive as plain FFI params rather than JSON so the shim needs no
// parser. `filters` is "Name|ext,ext|Name|ext" — the separators cannot appear
// in an extension, and a filter name containing one is the caller's problem.
// The answer is a JSON array of paths, or the literal `null` for a cancel.

const int32_t DLG_OPEN = 0;
const int32_t DLG_SAVE = 1;
const int32_t DLG_MULTIPLE = 1;   // flags bit 0
const int32_t DLG_DIRECTORY = 2;  // flags bit 1

struct DialogRequest {
  int32_t app = -1;
  int32_t job = -1;
  int32_t kind = DLG_OPEN;
  int32_t flags = 0;
  std::string title;
  std::string default_path;
  std::string default_name;
  std::string filters;
};

std::vector<std::string> split_on(const std::string &s, char sep) {
  std::vector<std::string> out;
  if (s.empty()) return out;
  std::string cur;
  for (size_t i = 0; i < s.size(); i++) {
    if (s[i] == sep) {
      out.push_back(cur);
      cur.clear();
    } else {
      cur.push_back(s[i]);
    }
  }
  out.push_back(cur);
  return out;
}

struct Filter {
  std::string name;
  std::vector<std::string> extensions;
};

std::vector<Filter> parse_filters(const std::string &spec) {
  std::vector<Filter> out;
  std::vector<std::string> parts = split_on(spec, '|');
  for (size_t i = 0; i + 1 < parts.size(); i += 2) {
    Filter f;
    f.name = parts[i];
    f.extensions = split_on(parts[i + 1], ',');
    if (!f.extensions.empty()) out.push_back(f);
  }
  return out;
}

// Paths are UTF-8 and JSON strings are UTF-8, so only the structural
// characters and C0 controls need escaping.
std::string json_escape(const std::string &s) {
  std::string out;
  out.reserve(s.size() + 2);
  out.push_back('"');
  for (size_t i = 0; i < s.size(); i++) {
    unsigned char c = static_cast<unsigned char>(s[i]);
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if (c < 0x20) {
          char buf[7];
          std::snprintf(buf, sizeof(buf), "\\u%04x", c);
          out += buf;
        } else {
          out.push_back(static_cast<char>(c));
        }
    }
  }
  out.push_back('"');
  return out;
}

std::string json_array(const std::vector<std::string> &items) {
  std::string out = "[";
  for (size_t i = 0; i < items.size(); i++) {
    if (i) out.push_back(',');
    out += json_escape(items[i]);
  }
  out.push_back(']');
  return out;
}

// Fills `out` and returns true when the user confirmed; returns false for a
// cancel. `error` is set only for a platform-level refusal.
bool run_file_dialog(const DialogRequest &req, std::vector<std::string> &out,
                     std::string &error);

// ---- menus: the part that is the same everywhere ---------------------------
//
// Three renderers sit below this: AppKit, Win32 and GTK. They agree on the
// wire format (see the note above apply_custom_menu) and on who owns a click.
//
// Ownership is a real question because the callback is per-app while the menu
// is not: on macOS the menu bar is process-global, on Windows and Linux it
// belongs to a window. The rule that works for both is the same one — the
// last app to call setMenu owns the clicks — so it lives here rather than
// three times below.
static int32_t g_menu_owner = -1;

static void menu_clicked(long tag) {
  App *a = g_menu_owner >= 0 ? app_at(g_menu_owner) : nullptr;
  if (!a || !a->on_menu) return;
  a->on_menu(static_cast<int32_t>(tag), a->on_menu_ctx);
}

static void claim_menu_owner(App *a) {
  g_menu_owner = -1;
  for (int32_t i = 0; i < 8; i++) {
    if (app_at(i) == a) { g_menu_owner = i; break; }
  }
}

// The app a handle-free call acts on.
//
// wv_perform_action takes no handle because on macOS it needs none: the
// responder chain and the key window are process state. Win32 and GTK do need
// a window, and `predefined.copy()` is imported as a bare function with no app
// in scope, so the shim resolves it here. janela opens one window, which is
// what makes "the app" unambiguous rather than a guess; the menu owner is
// preferred so a two-window future picks the one the user is driving.
// Fullscreen is both a window API (app.setFullscreen) and a menu action
// (predefined.fullscreen), and the action has to toggle, so it needs to read
// the state as well as set it. Declared here, defined by each renderer.
static int32_t platform_set_fullscreen(void *win, bool on);
static bool platform_is_fullscreen(void *win);

static App *current_app() {
  App *a = g_menu_owner >= 0 ? app_at(g_menu_owner) : nullptr;
  if (a) return a;
  for (int32_t i = 0; i < 8; i++) {
    if (g_apps[i].used) return &g_apps[i];
  }
  return nullptr;
}

#if defined(__APPLE__)

// A standard macOS main menu.
//
// On macOS a Command-key shortcut is a MENU key equivalent, not a
// window-manager gesture the way Alt+F4 is on Windows. With no main menu
// nothing claims Cmd+Q, Cmd+C, Cmd+V, Cmd+Z or Cmd+A, and a webview app simply
// appears to ignore them — the window had zero menu bars, which is exactly
// what that looks like from the outside.
//
// webview.h leaves this to the embedder on purpose: webview/webview#127 is
// still open, and #237, which added precisely this Edit menu, was closed with
// "anyone who is impatient can always take this code on their own". Tauri does
// the same thing one layer up, through muda.
//
// Every item here is a STANDARD AppKit selector travelling up the responder
// chain, so there is nothing to call back into TypeScript for and no new FFI
// surface. WKWebView answers the editing ones itself. Custom menus — a
// declarative table passed down from the host — are a separate feature.
static NSUInteger cocoa_mods(unsigned long symbolic);
static void add_app_submenu(id menubar, const std::string &name);
static void add_standard_editing_menus(id menubar);

// The application submenu, which AppKit requires be FIRST: it turns the main
// menu's first item into the app menu whatever that item is titled. A host
// menu starting with "File" would otherwise be rendered as the app menu and
// labelled with the bundle name, so this always goes in front of whatever the
// host asked for.
static id build_menubar_with_app_menu() {
  using namespace webview::detail;
  id app = objc::msg_send<id>(objc::get_class("NSApplication"),
                              objc::selector("sharedApplication"));
  if (!app) return nullptr;

  id process = objc::msg_send<id>(objc::get_class("NSProcessInfo"),
                                  objc::selector("processInfo"));
  const char *raw =
      process ? objc::msg_send<const char *>(
                    objc::msg_send<id>(process, objc::selector("processName")),
                    objc::selector("UTF8String"))
              : nullptr;
  id menubar = objc::msg_send<id>(
      objc::msg_send<id>(objc::get_class("NSMenu"), objc::selector("alloc")),
      objc::selector("init"));
  add_app_submenu(menubar, raw ? raw : "App");
  return menubar;
}

// The whole standard bar. Installed only when the host never calls setMenu —
// a scratch app still gets Cmd+Q and Cmd+V, while an app that sets its own
// menu owns the bar beyond the app submenu.
static void install_main_menu() {
  using namespace webview::detail;
  objc::autoreleasepool arp;

  id app = objc::msg_send<id>(objc::get_class("NSApplication"),
                              objc::selector("sharedApplication"));
  if (!app) return;
  if (objc::msg_send<id>(app, objc::selector("mainMenu"))) return;

  id menubar = build_menubar_with_app_menu();
  if (!menubar) return;
  add_standard_editing_menus(menubar);
  objc::msg_send<void>(app, objc::selector("setMainMenu:"), menubar);
}

// Shared by both paths: a submenu of items wired to standard selectors.
static void menu_add(id menu, const std::string &title, const char *sel,
                     const std::string &key, unsigned long symbolic) {
  using namespace webview::detail;
  id it = objc::msg_send<id>(
      objc::msg_send<id>(objc::get_class("NSMenuItem"), objc::selector("alloc")),
      objc::selector("initWithTitle:action:keyEquivalent:"),
      cocoa::NSString_stringWithUTF8String(title),
      sel ? objc::selector(sel) : nullptr,
      cocoa::NSString_stringWithUTF8String(key));
  objc::msg_send<void>(it, objc::selector("setKeyEquivalentModifierMask:"),
                       cocoa_mods(symbolic));
  objc::msg_send<void>(menu, objc::selector("addItem:"), it);
}

static void menu_add_separator(id menu) {
  using namespace webview::detail;
  objc::msg_send<void>(menu, objc::selector("addItem:"),
                       objc::msg_send<id>(objc::get_class("NSMenuItem"),
                                          objc::selector("separatorItem")));
}

static id menu_add_submenu(id menubar, const std::string &title) {
  using namespace webview::detail;
  id holder = objc::msg_send<id>(
      objc::msg_send<id>(objc::get_class("NSMenuItem"), objc::selector("alloc")),
      objc::selector("init"));
  id menu = objc::msg_send<id>(
      objc::msg_send<id>(objc::get_class("NSMenu"), objc::selector("alloc")),
      objc::selector("initWithTitle:"),
      cocoa::NSString_stringWithUTF8String(title));
  objc::msg_send<void>(holder, objc::selector("setTitle:"),
                       cocoa::NSString_stringWithUTF8String(title));
  objc::msg_send<void>(holder, objc::selector("setSubmenu:"), menu);
  objc::msg_send<void>(menubar, objc::selector("addItem:"), holder);
  return menu;
}

static void add_app_submenu(id menubar, const std::string &name) {
  id m = menu_add_submenu(menubar, name);
  menu_add(m, "About " + name, "orderFrontStandardAboutPanel:", "", 0);
  menu_add_separator(m);
  menu_add(m, "Hide " + name, "hide:", "h", 1);
  menu_add(m, "Hide Others", "hideOtherApplications:", "h", 1 | 4);
  menu_add(m, "Show All", "unhideAllApplications:", "", 0);
  menu_add_separator(m);
  // performClose:, not terminate: — measured: terminate: exits the process
  // itself so the host never returns from wv_run, while performClose: unwinds
  // through the window-close path the red button uses.
  menu_add(m, "Quit " + name, "performClose:", "q", 1);
}

// True if the bar already has a submenu with this title — the host declaring
// its own "Edit" must not get two.
static bool menubar_has(id menubar, const std::string &title) {
  using namespace webview::detail;
  NSUInteger n = objc::msg_send<NSUInteger>(menubar,
                                            objc::selector("numberOfItems"));
  for (NSUInteger i = 0; i < n; i++) {
    id item = objc::msg_send<id>(menubar, objc::selector("itemAtIndex:"), i);
    const char *got = cocoa::NSString_get_UTF8String(
        objc::msg_send<id>(item, objc::selector("title")));
    if (got && title == got) return true;
  }
  return false;
}

// Each of the three is filled in only if the host has not declared one under
// the same title. Guarded SEPARATELY, and not with an early return: a host
// that declares its own Edit would otherwise silently lose View and Window
// too — measured, before this was three checks instead of one.
static void add_standard_editing_menus(id menubar) {
  using namespace webview::detail;
  if (!menubar_has(menubar, "Edit")) {
    id edit = menu_add_submenu(menubar, "Edit");
    menu_add(edit, "Undo", "undo:", "z", 1);
    menu_add(edit, "Redo", "redo:", "z", 1 | 2);
    menu_add_separator(edit);
    menu_add(edit, "Cut", "cut:", "x", 1);
    menu_add(edit, "Copy", "copy:", "c", 1);
    menu_add(edit, "Paste", "paste:", "v", 1);
    menu_add(edit, "Select All", "selectAll:", "a", 1);
  }

  if (!menubar_has(menubar, "View")) {
    id view = menu_add_submenu(menubar, "View");
    menu_add(view, "Enter Full Screen", "toggleFullScreen:", "f", 1 | 8);
  }

  if (!menubar_has(menubar, "Window")) {
    id window = menu_add_submenu(menubar, "Window");
    menu_add(window, "Minimize", "performMiniaturize:", "m", 1);
    menu_add(window, "Close", "performClose:", "w", 1);
    id app = objc::msg_send<id>(objc::get_class("NSApplication"),
                                objc::selector("sharedApplication"));
    objc::msg_send<void>(app, objc::selector("setWindowsMenu:"), window);
  }
}

// ---- custom menus ------------------------------------------------------
//
// The host describes its menus declaratively in TypeScript and this renders
// them. Nothing here parses JSON: the runtime flattens the tree into one row
// per line, fields separated by 0x1f, which needs a split and nothing more.
//
//   S<US>Label      open a submenu
//   E               close it
//   I<US>tag<US>Label<US>key<US>mods<US>enabled<US>checked<US>checkable
//   -               a separator
//
// A click sends the item's tag back, which indexes the host's handler
// registry, and the tag goes up to TypeScript on the retained on_menu
// callback — the same shape as on_invoke.

// One shared target for every custom item; the tag says which one fired.
static id menu_target() {
  static id instance = nullptr;
  if (instance) return instance;
  constexpr auto class_name = "JanelaMenuTarget";
  // Registering the same class twice crashes, and this runs once per process
  // anyway — the lookup keeps a reload honest.
  Class cls = objc_lookUpClass(class_name);
  if (!cls) {
    cls = objc_allocateClassPair(
        webview::detail::objc::get_class("NSObject"), class_name, 0);
    class_addMethod(cls, webview::detail::objc::selector("janelaMenuAction:"),
                    (IMP)(+[](id, SEL, id sender) {
                      menu_clicked(webview::detail::objc::msg_send<long>(
                          sender, webview::detail::objc::selector("tag")));
                    }),
                    "v@:@");
    objc_registerClassPair(cls);
  }
  instance = webview::detail::objc::msg_send<id>(
      webview::detail::objc::msg_send<id>((id)cls,
                                          webview::detail::objc::selector("alloc")),
      webview::detail::objc::selector("init"));
  return instance;
}

// The platform's own menu items, by the host's action name.
//
// These carry a SELECTOR rather than a callback: Paste has to travel up the
// responder chain for WKWebView to handle it, so the behaviour is AppKit's and
// the click never reaches TypeScript. An unknown action renders nothing rather
// than a dead item.
struct Predefined {
  const char *action;
  const char *title;
  const char *selector;
  const char *key;
  unsigned long mods;  // symbolic, as the host sends them
};

static const Predefined *predefined_for(const std::string &action) {
  static const Predefined table[] = {
      {"about", "About", "orderFrontStandardAboutPanel:", "", 0},
      {"services", "Services", nullptr, "", 0},
      {"hide", "Hide", "hide:", "h", 1},
      {"hideOthers", "Hide Others", "hideOtherApplications:", "h", 1 | 4},
      {"showAll", "Show All", "unhideAllApplications:", "", 0},
      // performClose:, not terminate: — see the note on the standard menu.
      {"quit", "Quit", "performClose:", "q", 1},
      {"undo", "Undo", "undo:", "z", 1},
      {"redo", "Redo", "redo:", "z", 1 | 2},
      {"cut", "Cut", "cut:", "x", 1},
      {"copy", "Copy", "copy:", "c", 1},
      {"paste", "Paste", "paste:", "v", 1},
      {"selectAll", "Select All", "selectAll:", "a", 1},
      {"minimize", "Minimize", "performMiniaturize:", "m", 1},
      {"zoom", "Zoom", "performZoom:", "", 0},
      {"fullscreen", "Enter Full Screen", "toggleFullScreen:", "f", 1 | 8},
      {"closeWindow", "Close Window", "performClose:", "w", 1},
  };
  for (const Predefined &p : table) {
    if (action == p.action) return &p;
  }
  return nullptr;
}

// Perform a platform action right now, from wherever the host calls it.
//
// The interesting case is copy/paste/undo: those are not "do this" but a
// SELECTOR sent up the responder chain, and by the time a TypeScript handler
// runs the menu click has already been delivered to us. sendAction:to:nil
// walks the chain at this moment instead, which is what lets it still reach
// the WKWebView's editing context.
static int32_t perform_action(const std::string &action) {
  using namespace webview::detail;
  objc::autoreleasepool arp;
  const Predefined *pd = predefined_for(action);
  if (!pd || !pd->selector) return -1;
  id app = objc::msg_send<id>(objc::get_class("NSApplication"),
                              objc::selector("sharedApplication"));
  if (!app) return -1;

  // to:nil walks the responder chain from the key window's first responder,
  // which is how this reaches the WKWebView's editing context.
  if (objc::msg_send<bool>(app, objc::selector("sendAction:to:from:"),
                           objc::selector(pd->selector), nullptr, app)) {
    return 0;
  }

  // Falls back to addressing the first responder directly. Observed once, on
  // the very first launch: the window had not become key yet, so the chain
  // walk above found nobody. Three runs in a row succeed on the first path
  // once the app is settled, so this is a belt for the startup edge.
  id key_window = objc::msg_send<id>(app, objc::selector("keyWindow"));
  id responder = key_window ? objc::msg_send<id>(
                                  key_window, objc::selector("firstResponder"))
                            : nullptr;
  if (responder &&
      objc::msg_send<bool>(app, objc::selector("sendAction:to:from:"),
                           objc::selector(pd->selector), responder, app)) {
    return 0;
  }
  return -1;
}


// The host sends modifiers symbolically; this is the AppKit half of the map.
// MOD_PRIMARY is Command here — on Windows and Linux the same bit becomes
// Control, which is the whole point of sending intent rather than constants.
static NSUInteger cocoa_mods(unsigned long symbolic) {
  const NSUInteger kShift = 1UL << 17;
  const NSUInteger kControl = 1UL << 18;
  const NSUInteger kOption = 1UL << 19;
  const NSUInteger kCommand = 1UL << 20;
  NSUInteger out = 0;
  if (symbolic & 1) out |= kCommand;   // primary
  if (symbolic & 2) out |= kShift;
  if (symbolic & 4) out |= kOption;
  if (symbolic & 8) out |= kControl;
  if (symbolic & 16) out |= kCommand;
  return out;
}

// Retains the item under its tag so a later setEnabled/setChecked/setLabel can
// find it. The vector is sized to fit rather than pushed, because the host's
// tags are registry indices and need not arrive in order.
static void remember_item(App *a, long tag, id item) {
  if (tag < 0) return;
  size_t at = static_cast<size_t>(tag);
  if (a->menu_items.size() <= at) a->menu_items.resize(at + 1, nullptr);
  a->menu_items[at] = webview::detail::objc::retain(item);
}

static id item_at(App *a, int32_t tag) {
  if (tag < 0 || static_cast<size_t>(tag) >= a->menu_items.size()) return nullptr;
  return static_cast<id>(a->menu_items[static_cast<size_t>(tag)]);
}

// Appends the host's submenus to the standard menu bar rather than replacing
// it: a custom menu must not be able to cost the app Cmd+Q and Cmd+V, which is
// what replacing the bar wholesale would do.
static int32_t apply_custom_menu(App *a, const std::string &spec) {
  using namespace webview::detail;
  objc::autoreleasepool arp;

  id app = objc::msg_send<id>(objc::get_class("NSApplication"),
                              objc::selector("sharedApplication"));
  if (!app) return -1;

  // A fresh bar every time: the host owns what it declared, so setMenu
  // replaces rather than appends and the menu can shrink as well as grow.
  //
  // The application submenu is prepended regardless, because AppKit turns the
  // main menu's FIRST item into the app menu whatever it is titled — a host
  // menu starting with "File" would otherwise be rendered as the app menu and
  // labelled with the bundle name. It is also the floor under Cmd+Q.
  id menubar = build_menubar_with_app_menu();
  if (!menubar) return -1;

  for (void *old_item : a->menu_items) {
    if (old_item) objc::release(static_cast<id>(old_item));
  }
  a->menu_items.clear();

  std::vector<id> stack;
  stack.push_back(menubar);

  for (const std::string &line : split_on(spec, '\n')) {
    if (line.empty()) continue;
    std::vector<std::string> f = split_on(line, '\x1f');
    const std::string &kind = f[0];

    if (kind == "S" && f.size() >= 2) {
      id holder = objc::msg_send<id>(
          objc::msg_send<id>(objc::get_class("NSMenuItem"),
                             objc::selector("alloc")),
          objc::selector("init"));
      id menu = objc::msg_send<id>(
          objc::msg_send<id>(objc::get_class("NSMenu"),
                             objc::selector("alloc")),
          objc::selector("initWithTitle:"),
          cocoa::NSString_stringWithUTF8String(f[1]));
      objc::msg_send<void>(holder, objc::selector("setTitle:"),
                           cocoa::NSString_stringWithUTF8String(f[1]));
      // Without this AppKit decides each item's enabled state from the
      // responder chain and setEnabled: is silently ignored — the item stays
      // live however many times the host disables it.
      objc::msg_send<void>(menu, objc::selector("setAutoenablesItems:"), false);
      objc::msg_send<void>(holder, objc::selector("setSubmenu:"), menu);
      objc::msg_send<void>(stack.back(), objc::selector("addItem:"), holder);
      stack.push_back(menu);
    } else if (kind == "E") {
      if (stack.size() > 1) stack.pop_back();
    } else if (kind == "-") {
      if (stack.size() > 1) {
        objc::msg_send<void>(
            stack.back(), objc::selector("addItem:"),
            objc::msg_send<id>(objc::get_class("NSMenuItem"),
                               objc::selector("separatorItem")));
      }
    } else if (kind == "I" && f.size() >= 8 && stack.size() > 1) {
      // The host owns the tag: it indexes the handler registry in TypeScript,
      // so the numbering has to come from there rather than from insertion
      // order here.
      long tag = strtol(f[1].c_str(), nullptr, 10);
      id it = objc::msg_send<id>(
          objc::msg_send<id>(objc::get_class("NSMenuItem"),
                             objc::selector("alloc")),
          objc::selector("initWithTitle:action:keyEquivalent:"),
          cocoa::NSString_stringWithUTF8String(f[2]),
          objc::selector("janelaMenuAction:"),
          cocoa::NSString_stringWithUTF8String(f[3]));
      objc::msg_send<void>(it, objc::selector("setTarget:"), menu_target());
      objc::msg_send<void>(it, objc::selector("setTag:"), tag);
      // Always set the mask, including 0: AppKit's default for a key
      // equivalent is Command, so leaving it alone would turn an accelerator
      // with no modifiers into a Command shortcut.
      objc::msg_send<void>(it, objc::selector("setKeyEquivalentModifierMask:"),
                           cocoa_mods(strtoul(f[4].c_str(), nullptr, 10)));
      objc::msg_send<void>(it, objc::selector("setEnabled:"), f[5] == "1");
      // f[7] says the item is checkable. AppKit lets any item carry a state,
      // so it is unused here — it is on the wire for the GTK renderer, which
      // has to choose GtkCheckMenuItem at construction.
      objc::msg_send<void>(it, objc::selector("setState:"),
                           static_cast<NSInteger>(f[6] == "1" ? 1 : 0));
      objc::msg_send<void>(stack.back(), objc::selector("addItem:"), it);
      remember_item(a, tag, it);
    }
  }

  // The floor goes back on AFTER the host's menus, which also puts them in
  // macOS's conventional order: App, File, …, Edit, View, Window. Without this
  // any setMenu at all would cost the app ⌘C and ⌘V — the exact bug the
  // standard bar exists to prevent, reintroduced by the feature that was
  // supposed to build on it. A host that declares its own Edit, View or Window
  // keeps it; only the missing ones are filled in.
  add_standard_editing_menus(menubar);

  objc::msg_send<void>(app, objc::selector("setMainMenu:"), menubar);
  a->menu_set = true;
  claim_menu_owner(a);
  return 0;
}

// The live-item setters. Each takes the host's tag, which is a registry index
// in TypeScript, and -1 for an unknown one rather than silence — a stale
// handle should be visible, not a no-op.
static int32_t menu_set_enabled(App *a, int32_t tag, int32_t on) {
  using namespace webview::detail;
  objc::autoreleasepool arp;
  id it = item_at(a, tag);
  if (!it) return -1;
  objc::msg_send<void>(it, objc::selector("setEnabled:"), on != 0);
  return 0;
}

static int32_t menu_set_checked(App *a, int32_t tag, int32_t on) {
  using namespace webview::detail;
  objc::autoreleasepool arp;
  id it = item_at(a, tag);
  if (!it) return -1;
  // NSControlStateValueOn / Off.
  objc::msg_send<void>(it, objc::selector("setState:"),
                       static_cast<NSInteger>(on != 0 ? 1 : 0));
  return 0;
}

static int32_t menu_set_label(App *a, int32_t tag, const std::string &label) {
  using namespace webview::detail;
  objc::autoreleasepool arp;
  id it = item_at(a, tag);
  if (!it) return -1;
  objc::msg_send<void>(it, objc::selector("setTitle:"),
                       cocoa::NSString_stringWithUTF8String(label));
  return 0;
}

bool run_file_dialog(const DialogRequest &req, std::vector<std::string> &out,
                     std::string &error) {
  (void)error;
  using namespace webview::detail;
  objc::autoreleasepool arp;

  bool save = req.kind == DLG_SAVE;
  id panel = save ? objc::msg_send<id>(objc::get_class("NSSavePanel"),
                                       objc::selector("savePanel"))
                  : cocoa::NSOpenPanel_openPanel();
  if (!panel) return false;

  if (!req.title.empty()) {
    objc::msg_send<void>(panel, objc::selector("setTitle:"),
                         cocoa::NSString_stringWithUTF8String(req.title));
  }
  if (!req.default_path.empty()) {
    id url = objc::msg_send<id>(
        objc::get_class("NSURL"), objc::selector("fileURLWithPath:"),
        cocoa::NSString_stringWithUTF8String(req.default_path));
    objc::msg_send<void>(panel, objc::selector("setDirectoryURL:"), url);
  }
  if (save && !req.default_name.empty()) {
    objc::msg_send<void>(panel, objc::selector("setNameFieldStringValue:"),
                         cocoa::NSString_stringWithUTF8String(req.default_name));
  }

  std::vector<Filter> filters = parse_filters(req.filters);
  if (!filters.empty()) {
    // setAllowedFileTypes: is deprecated in favour of UTType on macOS 12+, but
    // still honoured, and it takes plain extension strings — the UTType path
    // would need a type lookup per extension for no gain here.
    id types = objc::msg_send<id>(objc::get_class("NSMutableArray"),
                                  objc::selector("array"));
    for (size_t i = 0; i < filters.size(); i++) {
      for (size_t j = 0; j < filters[i].extensions.size(); j++) {
        const std::string &ext = filters[i].extensions[j];
        if (ext.empty() || ext == "*") continue;
        objc::msg_send<void>(types, objc::selector("addObject:"),
                             cocoa::NSString_stringWithUTF8String(ext));
      }
    }
    if (objc::msg_send<NSUInteger>(types, objc::selector("count")) > 0) {
      objc::msg_send<void>(panel, objc::selector("setAllowedFileTypes:"), types);
    }
  }

  if (!save) {
    bool want_dirs = (req.flags & DLG_DIRECTORY) != 0;
    cocoa::NSOpenPanel_set_canChooseFiles(panel, !want_dirs);
    cocoa::NSOpenPanel_set_canChooseDirectories(panel, want_dirs);
    cocoa::NSOpenPanel_set_allowsMultipleSelection(
        panel, (req.flags & DLG_MULTIPLE) != 0);
  }

  if (cocoa::NSSavePanel_runModal(panel) != cocoa::NSModalResponseOK) {
    return false;
  }

  auto path_of = [](id url) -> std::string {
    id path = objc::msg_send<id>(url, objc::selector("path"));
    const char *utf8 = cocoa::NSString_get_UTF8String(path);
    return utf8 ? std::string(utf8) : std::string();
  };

  if (save) {
    id url = objc::msg_send<id>(panel, objc::selector("URL"));
    if (!url) return false;
    out.push_back(path_of(url));
    return true;
  }

  id urls = cocoa::NSOpenPanel_get_URLs(panel);
  NSUInteger n = objc::msg_send<NSUInteger>(urls, objc::selector("count"));
  for (NSUInteger i = 0; i < n; i++) {
    id url = objc::msg_send<id>(urls, objc::selector("objectAtIndex:"), i);
    out.push_back(path_of(url));
  }
  return !out.empty();
}


// Releases the retained items. The menu bar itself belongs to NSApplication,
// which replaces it wholesale on the next setMenu.
static void menu_teardown(App *a) {
  using namespace webview::detail;
  for (void *it : a->menu_items) {
    if (it) objc::release(static_cast<id>(it));
  }
  a->menu_items.clear();
}

// AppKit parents the webview eagerly, so nothing here has to wait for run.
static void menu_realize(App *) {}

static bool platform_is_fullscreen(void *win) {
  using namespace webview::detail;
  objc::autoreleasepool arp;
  // NSWindowStyleMaskFullScreen.
  const NSUInteger full = 1UL << 14;
  NSUInteger mask = objc::msg_send<NSUInteger>(static_cast<id>(win),
                                               objc::selector("styleMask"));
  return (mask & full) != 0;
}

static int32_t platform_set_fullscreen(void *win, bool on) {
  using namespace webview::detail;
  objc::autoreleasepool arp;
  // toggleFullScreen: only toggles, so read the current state first and leave
  // it alone when it already matches.
  if (platform_is_fullscreen(win) != on) {
    objc::msg_send<void>(static_cast<id>(win),
                         objc::selector("toggleFullScreen:"), nullptr);
  }
  return 0;
}
#elif defined(_WIN32)

std::string from_wide(const wchar_t *w, int wlen) {
  if (!w || wlen == 0) return std::string();
  int n = WideCharToMultiByte(CP_UTF8, 0, w, wlen, nullptr, 0, nullptr, nullptr);
  if (n <= 0) return std::string();
  std::string out(static_cast<size_t>(n), '\0');
  WideCharToMultiByte(CP_UTF8, 0, w, wlen, &out[0], n, nullptr, nullptr);
  return out;
}

std::wstring to_wide(const std::string &s) {
  if (s.empty()) return std::wstring();
  int n = MultiByteToWideChar(CP_UTF8, 0, s.data(),
                              static_cast<int>(s.size()), nullptr, 0);
  if (n <= 0) return std::wstring();
  std::wstring out(static_cast<size_t>(n), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), &out[0],
                      n);
  return out;
}

bool run_file_dialog(const DialogRequest &req, std::vector<std::string> &out,
                     std::string &error) {
  if (req.flags & DLG_DIRECTORY) {
    error = "ENOTSUP: directory selection is not implemented on Windows";
    return false;
  }

  // GetOpenFileNameW/GetSaveFileNameW render the modern common item dialog on
  // Vista and later as long as no hook is installed, so this buys the current
  // look without the COM ceremony of IFileDialog.
  std::vector<Filter> filters = parse_filters(req.filters);
  std::wstring filter_buf;
  for (size_t i = 0; i < filters.size(); i++) {
    std::string patterns;
    for (size_t j = 0; j < filters[i].extensions.size(); j++) {
      if (j) patterns += ";";
      patterns += "*." + filters[i].extensions[j];
    }
    filter_buf += to_wide(filters[i].name + " (" + patterns + ")");
    filter_buf.push_back(L'\0');
    filter_buf += to_wide(patterns);
    filter_buf.push_back(L'\0');
  }
  if (!filter_buf.empty()) filter_buf.push_back(L'\0');

  // Multi-select returns "dir\0name\0name\0\0", so the buffer must hold more
  // than one MAX_PATH.
  std::vector<wchar_t> file(32768, L'\0');
  std::wstring initial_name = to_wide(req.default_name);
  if (!initial_name.empty() && initial_name.size() < file.size() - 1) {
    std::memcpy(file.data(), initial_name.c_str(),
                (initial_name.size() + 1) * sizeof(wchar_t));
  }
  std::wstring initial_dir = to_wide(req.default_path);
  std::wstring title = to_wide(req.title);

  OPENFILENAMEW ofn;
  std::memset(&ofn, 0, sizeof(ofn));
  ofn.lStructSize = sizeof(ofn);
  ofn.hwndOwner = nullptr;
  ofn.lpstrFilter = filter_buf.empty() ? nullptr : filter_buf.c_str();
  ofn.lpstrFile = file.data();
  ofn.nMaxFile = static_cast<DWORD>(file.size());
  ofn.lpstrInitialDir = initial_dir.empty() ? nullptr : initial_dir.c_str();
  ofn.lpstrTitle = title.empty() ? nullptr : title.c_str();
  ofn.Flags = OFN_NOCHANGEDIR | OFN_EXPLORER;

  if (req.kind == DLG_SAVE) {
    ofn.Flags |= OFN_OVERWRITEPROMPT;
    if (!GetSaveFileNameW(&ofn)) return false;
    out.push_back(from_wide(ofn.lpstrFile, -1));
    if (!out.back().empty()) out.back().pop_back();  // trailing NUL from -1
    return true;
  }

  ofn.Flags |= OFN_FILEMUSTEXIST | OFN_PATHMUSTEXIST;
  if (req.flags & DLG_MULTIPLE) ofn.Flags |= OFN_ALLOWMULTISELECT;
  if (!GetOpenFileNameW(&ofn)) return false;

  // Single selection is one NUL-terminated path; multiple is a directory
  // followed by bare names, all NUL-separated, ending in a double NUL.
  const wchar_t *p = ofn.lpstrFile;
  std::string first = from_wide(p, static_cast<int>(wcslen(p)));
  p += wcslen(p) + 1;
  if (*p == L'\0') {
    out.push_back(first);
    return true;
  }
  while (*p) {
    std::string name = from_wide(p, static_cast<int>(wcslen(p)));
    out.push_back(first + "\\" + name);
    p += wcslen(p) + 1;
  }
  return !out.empty();
}

#else  // GTK

bool run_file_dialog(const DialogRequest &req, std::vector<std::string> &out,
                     std::string &error) {
  (void)error;
  bool save = req.kind == DLG_SAVE;
  bool want_dirs = (req.flags & DLG_DIRECTORY) != 0;
  GtkFileChooserAction action =
      save ? GTK_FILE_CHOOSER_ACTION_SAVE
           : (want_dirs ? GTK_FILE_CHOOSER_ACTION_SELECT_FOLDER
                        : GTK_FILE_CHOOSER_ACTION_OPEN);

  GtkWidget *dialog = gtk_file_chooser_dialog_new(
      req.title.empty() ? (save ? "Save" : "Open") : req.title.c_str(), nullptr,
      action, "_Cancel", GTK_RESPONSE_CANCEL,
      save ? "_Save" : "_Open", GTK_RESPONSE_ACCEPT, nullptr);
  if (!dialog) return false;

  GtkFileChooser *chooser = GTK_FILE_CHOOSER(dialog);
  if (!save && (req.flags & DLG_MULTIPLE)) {
    gtk_file_chooser_set_select_multiple(chooser, TRUE);
  }
  if (save) {
    gtk_file_chooser_set_do_overwrite_confirmation(chooser, TRUE);
    if (!req.default_name.empty()) {
      gtk_file_chooser_set_current_name(chooser, req.default_name.c_str());
    }
  }
  if (!req.default_path.empty()) {
    gtk_file_chooser_set_current_folder(chooser, req.default_path.c_str());
  }

  std::vector<Filter> filters = parse_filters(req.filters);
  for (size_t i = 0; i < filters.size(); i++) {
    GtkFileFilter *f = gtk_file_filter_new();
    gtk_file_filter_set_name(f, filters[i].name.c_str());
    for (size_t j = 0; j < filters[i].extensions.size(); j++) {
      std::string pattern = "*." + filters[i].extensions[j];
      gtk_file_filter_add_pattern(f, pattern.c_str());
    }
    gtk_file_chooser_add_filter(chooser, f);
  }

  bool ok = gtk_dialog_run(GTK_DIALOG(dialog)) == GTK_RESPONSE_ACCEPT;
  if (ok) {
    if (!save && (req.flags & DLG_MULTIPLE)) {
      GSList *names = gtk_file_chooser_get_filenames(chooser);
      for (GSList *it = names; it; it = it->next) {
        char *path = static_cast<char *>(it->data);
        if (path) {
          out.push_back(path);
          g_free(path);
        }
      }
      g_slist_free(names);
    } else {
      char *path = gtk_file_chooser_get_filename(chooser);
      if (path) {
        out.push_back(path);
        g_free(path);
      }
    }
  }
  gtk_widget_destroy(dialog);
  // Let the destroy actually happen before the modal's caller resumes.
  while (gtk_events_pending()) gtk_main_iteration();
  return ok && !out.empty();
}

#endif

#if defined(__APPLE__)
// The AppKit renderer is further up, beside the standard menu bar it shares
// its helpers with. This chain covers the other two.
#elif defined(_WIN32)

// ---- Win32 menus -----------------------------------------------------------
//
// There is no standard bar to install here. Alt+F4 is a window-manager
// message the win32 backend already answers as WM_CLOSE, and Ctrl+C/V/Z/A are
// handled inside WebView2 — so unlike macOS, an app that says nothing about
// menus loses nothing by having none. A menu on Windows is a feature the app
// asked for, not a floor under the keyboard.
static void install_main_menu() {}

// The window that owns the menu bar, and the wndproc that was there before we
// subclassed it. Process-wide because janela opens one window; the menu bar
// itself is per-window, so a second one would need these per App.
static HWND g_menu_hwnd = nullptr;
static WNDPROC g_prev_wndproc = nullptr;
static HACCEL g_accel = nullptr;
static HHOOK g_accel_hook = nullptr;
static HMENU g_menu_bar = nullptr;
static bool g_win_fullscreen = false;

// WM_COMMAND's id is 16 bits, and Windows reserves the low range for its own
// controls (IDOK is 1), so item ids start well clear of it.
static const UINT kIdItemBase = 0x4000;

static std::wstring widen(const std::string &s) {
  if (s.empty()) return std::wstring();
  int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), static_cast<int>(s.size()),
                              nullptr, 0);
  if (n <= 0) return std::wstring();
  std::wstring out(static_cast<size_t>(n), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.c_str(), static_cast<int>(s.size()),
                      &out[0], n);
  return out;
}

// A literal ampersand in a menu label is a mnemonic marker, so a label like
// "Cut && Paste" has to be escaped or Windows eats the character and
// underlines the P.
static std::string escape_mnemonics(const std::string &s) {
  std::string out;
  for (char c : s) {
    out.push_back(c);
    if (c == '&') out.push_back('&');
  }
  return out;
}

// The host sends a lowercased key name. A single character goes through the
// keyboard layout; everything else is a named key, which is the only way F5 or
// Delete can be an accelerator at all. `shown` is what the menu prints, which
// is not always the name that was sent.
static bool vk_for_key(const std::string &key, WORD &vk, std::string &shown) {
  if (key.empty()) return false;
  if (key.size() == 1) {
    SHORT s = VkKeyScanW(static_cast<wchar_t>(
        static_cast<unsigned char>(std::toupper(
            static_cast<unsigned char>(key[0])))));
    if (s == -1) return false;
    vk = static_cast<WORD>(s & 0xFF);
    shown = std::string(1, static_cast<char>(std::toupper(
        static_cast<unsigned char>(key[0]))));
    return true;
  }
  if (key[0] == 'f' && key.size() <= 3) {
    int n = atoi(key.c_str() + 1);
    if (n >= 1 && n <= 24) {
      vk = static_cast<WORD>(VK_F1 + n - 1);
      shown = "F" + std::to_string(n);
      return true;
    }
  }
  struct Named { const char *name; WORD vk; const char *shown; };
  static const Named table[] = {
      {"enter", VK_RETURN, "Enter"},   {"return", VK_RETURN, "Enter"},
      {"escape", VK_ESCAPE, "Esc"},    {"esc", VK_ESCAPE, "Esc"},
      {"space", VK_SPACE, "Space"},    {"tab", VK_TAB, "Tab"},
      {"backspace", VK_BACK, "Backspace"},
      {"delete", VK_DELETE, "Del"},    {"del", VK_DELETE, "Del"},
      {"insert", VK_INSERT, "Ins"},    {"up", VK_UP, "Up"},
      {"down", VK_DOWN, "Down"},       {"left", VK_LEFT, "Left"},
      {"right", VK_RIGHT, "Right"},    {"home", VK_HOME, "Home"},
      {"end", VK_END, "End"},          {"pageup", VK_PRIOR, "PgUp"},
      {"pagedown", VK_NEXT, "PgDn"},
  };
  for (const Named &n : table) {
    if (key == n.name) {
      vk = n.vk;
      shown = n.shown;
      return true;
    }
  }
  return false;
}

// What the menu prints to the right of the label. MOD_PRIMARY is Control here
// — the same symbolic bit AppKit renders as Command, which is the whole point
// of the host sending intent rather than platform constants.
static std::string accel_text(const std::string &shown, unsigned long mods) {
  std::string out;
  if (mods & (1 | 8)) out += "Ctrl+";
  if (mods & 4) out += "Alt+";
  if (mods & 2) out += "Shift+";
  return out.empty() && shown.empty() ? std::string() : out + shown;
}

// ---- the editing commands, through the DevTools protocol -------------------
//
// WebView2 runs the page out of process and exposes no copy/paste entry point,
// and a webview blocks document.execCommand("paste"). What it DOES expose is
// the DevTools protocol, and CDP's Input.dispatchKeyEvent takes a `commands`
// array: Blink's own editor commands, the same ones a real Ctrl+V runs,
// executed in the browser process where the clipboard actually lives.
//
// Measured against Chromium (which is what WebView2 is), with a sentinel in
// the system clipboard before and after: copy writes it, paste reads it, cut
// does both. Blink refuses the clipboard half when the page is not focused,
// which is why this dispatches at the webview rather than asking the page.
//
// undo, redo and selectAll would also work through plain ExecuteScript —
// document.execCommand allows those without a user gesture, measured — but
// routing all six the same way leaves one mechanism to be wrong instead of two.
struct CdpDone final
    : public ICoreWebView2CallDevToolsProtocolMethodCompletedHandler {
  // The reply is of no interest; the call is fire-and-forget. A static
  // instance with inert refcounting is why there is no lifetime to manage.
  // The two IIDs come from different places, and each is the only one that
  // links. IID_IUnknown lives in libuuid — pulling a whole library into every
  // Windows build for one GUID is a worse trade than __uuidof, which mingw
  // declares and the compiler folds in place. WebView2's own IIDs go the other
  // way: the SDK header defines them `selectany`, but attaches no
  // __declspec(uuid), so __uuidof on one is an undefined symbol. Both mistakes
  // are LINK errors, which -fsyntax-only does not catch — see the win32 link
  // check in the cross-compile notes.
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void **ppv) override {
    if (!ppv) return E_POINTER;
    if (riid == __uuidof(IUnknown) ||
        riid == IID_ICoreWebView2CallDevToolsProtocolMethodCompletedHandler) {
      *ppv = static_cast<ICoreWebView2CallDevToolsProtocolMethodCompletedHandler *>(this);
      return S_OK;
    }
    *ppv = nullptr;
    return E_NOINTERFACE;
  }
  ULONG STDMETHODCALLTYPE AddRef() override { return 2; }
  ULONG STDMETHODCALLTYPE Release() override { return 1; }
  HRESULT STDMETHODCALLTYPE Invoke(HRESULT, LPCWSTR) override { return S_OK; }
};

static ICoreWebView2 *core_webview(App *a) {
  if (!a || !a->w) return nullptr;
  void *h = webview_get_native_handle(
      a->w, WEBVIEW_NATIVE_HANDLE_KIND_BROWSER_CONTROLLER);
  if (!h) return nullptr;
  auto *controller = static_cast<ICoreWebView2Controller *>(h);
  ICoreWebView2 *core = nullptr;
  if (FAILED(controller->get_CoreWebView2(&core))) return nullptr;
  return core;  // borrowed: the controller owns it for the app's lifetime
}

// The key is the one the command's real shortcut uses, because `commands` is
// "the editing commands associated with THIS key event" — Blink runs them in
// place of the key's default handling, so a mismatched key would be a lie in
// anything that observes the event.
struct EditCommand {
  const char *action;
  const char *command;  // Blink's name, which is not always ours
  int vk;
  const char *key;
  const char *code;
  bool shift;
};

static int32_t cdp_edit(App *a, const EditCommand &e) {
  ICoreWebView2 *core = core_webview(a);
  if (!core) return -1;
  char json[320];
  // modifiers is a bitmask: 2 is Ctrl, 8 is Shift.
  snprintf(json, sizeof(json),
           "{\"type\":\"rawKeyDown\",\"modifiers\":%d,"
           "\"windowsVirtualKeyCode\":%d,\"nativeVirtualKeyCode\":%d,"
           "\"key\":\"%s\",\"code\":\"%s\",\"commands\":[\"%s\"]}",
           e.shift ? 2 | 8 : 2, e.vk, e.vk, e.key, e.code, e.command);
  static CdpDone done;
  return SUCCEEDED(core->CallDevToolsProtocolMethod(
             L"Input.dispatchKeyEvent", widen(json).c_str(), &done))
             ? 0
             : -1;
}

// The process name, which is what macOS's application menu shows and so what
// About should say here too. Windows has no NSProcessInfo; the executable's
// basename without its extension is the same thing by another route.
static std::wstring process_name() {
  wchar_t path[MAX_PATH];
  DWORD n = GetModuleFileNameW(nullptr, path, MAX_PATH);
  if (n == 0 || n >= MAX_PATH) return L"App";
  std::wstring s(path, n);
  size_t slash = s.find_last_of(L"\\/");
  if (slash != std::wstring::npos) s = s.substr(slash + 1);
  size_t dot = s.find_last_of(L'.');
  if (dot != std::wstring::npos && dot > 0) s = s.substr(0, dot);
  return s.empty() ? L"App" : s;
}

// ShellAboutW spins its own message loop, so it must not run with a TypeScript
// frame beneath it — the menu handler that asked for it is still on the stack.
// Posting it to a later UI turn is the same rule the file dialogs follow.
static void about_on_ui_thread(webview_t w, void *) {
  const std::wstring name = process_name();
  ShellAboutW(static_cast<HWND>(webview_get_window(w)), name.c_str(), L"",
              nullptr);
}

static int32_t perform_action(const std::string &action) {
  App *a = current_app();
  HWND hwnd = a && a->w ? static_cast<HWND>(webview_get_window(a->w))
                        : g_menu_hwnd;
  if (!hwnd) return -1;
  // performClose:'s counterpart: WM_CLOSE unwinds through the same path the
  // title bar's X uses, so the host returns from wv_run instead of the process
  // vanishing under it.
  if (action == "quit" || action == "closeWindow") {
    PostMessageW(hwnd, WM_CLOSE, 0, 0);
    return 0;
  }
  if (action == "minimize") {
    ShowWindow(hwnd, SW_MINIMIZE);
    return 0;
  }
  if (action == "zoom") {
    ShowWindow(hwnd, IsZoomed(hwnd) ? SW_RESTORE : SW_MAXIMIZE);
    return 0;
  }
  if (action == "fullscreen") {
    platform_set_fullscreen(hwnd, !g_win_fullscreen);
    return 0;
  }
  if (action == "about") {
    return webview_dispatch(a->w, about_on_ui_thread, nullptr) == WEBVIEW_ERROR_OK
               ? 0
               : -1;
  }

  static const EditCommand edits[] = {
      {"undo", "undo", 'Z', "z", "KeyZ", false},
      // Windows redo is Ctrl+Y where macOS is Shift+Cmd+Z. Blink's command
      // name is the same either way; only the key event differs.
      {"redo", "redo", 'Y', "y", "KeyY", false},
      {"cut", "cut", 'X', "x", "KeyX", false},
      {"copy", "copy", 'C', "c", "KeyC", false},
      {"paste", "paste", 'V', "v", "KeyV", false},
      {"selectAll", "selectAll", 'A', "a", "KeyA", false},
  };
  for (const EditCommand &e : edits) {
    if (action == e.action) return cdp_edit(a, e);
  }

  // hide, hideOthers and showAll are what is left, and they are not a missing
  // API but a missing CONCEPT. macOS hide is application state — windows
  // vanish, the app stays in the Dock, one click brings it back. The nearest
  // Windows call, ShowWindow(SW_HIDE), takes the window out of the taskbar and
  // Alt+Tab with no way back short of a tray icon; hideOthers and showAll
  // reach into other applications. False beats a dead menu entry.
  return -1;
}

// A menu click and an accelerator both arrive as WM_COMMAND on the window that
// owns the menu; the high word says which (0 for a menu, 1 for an accelerator)
// and both are ours. Everything else goes back to webview.h's own wndproc —
// this subclass adds a case, it does not replace the window's behaviour.
static LRESULT CALLBACK menu_wndproc(HWND hwnd, UINT msg, WPARAM wp,
                                     LPARAM lp) {
  if (msg == WM_COMMAND && lp == 0 && (HIWORD(wp) == 0 || HIWORD(wp) == 1)) {
    UINT id = LOWORD(wp);
    if (id >= kIdItemBase) {
      menu_clicked(static_cast<long>(id - kIdItemBase));
      return 0;
    }
  }
  return g_prev_wndproc
             ? CallWindowProcW(g_prev_wndproc, hwnd, msg, wp, lp)
             : DefWindowProcW(hwnd, msg, wp, lp);
}

// Accelerators need TranslateAcceleratorW, and webview.h's loop never calls it
// (win32_edge.hh, run_impl: GetMessageW / TranslateMessage / DispatchMessageW
// and nothing else). We do not own that loop — but a WH_GETMESSAGE hook runs
// INSIDE its GetMessageW, which is the same point in the cycle. Rewriting a
// consumed message to WM_NULL is how the key stops here instead of also
// reaching the page, which is what a real accelerator does.
static LRESULT CALLBACK accel_hook(int code, WPARAM wp, LPARAM lp) {
  if (code == HC_ACTION && wp == PM_REMOVE && g_accel && g_menu_hwnd) {
    MSG *msg = reinterpret_cast<MSG *>(lp);
    if (msg && msg->message >= WM_KEYFIRST && msg->message <= WM_KEYLAST &&
        (msg->hwnd == g_menu_hwnd || IsChild(g_menu_hwnd, msg->hwnd))) {
      if (TranslateAcceleratorW(g_menu_hwnd, g_accel, msg)) {
        msg->message = WM_NULL;
        msg->wParam = 0;
        msg->lParam = 0;
      }
    }
  }
  return CallNextHookEx(nullptr, code, wp, lp);
}

static int32_t apply_custom_menu(App *a, const std::string &spec) {
  HWND hwnd = a->w ? static_cast<HWND>(webview_get_window(a->w)) : nullptr;
  if (!hwnd) return -1;

  // A fresh bar every time: the host owns what it declared, so setMenu
  // replaces rather than appends and the menu can shrink as well as grow.
  HMENU bar = CreateMenu();
  if (!bar) return -1;

  a->menu_items.clear();
  std::vector<ACCEL> accels;

  // The bar itself plus one popup per open submenu. Popups are appended to
  // their parent as they are created, so destroying the bar destroys them all.
  std::vector<HMENU> stack;
  stack.push_back(bar);

  for (const std::string &line : split_on(spec, '\n')) {
    if (line.empty()) continue;
    std::vector<std::string> f = split_on(line, '\x1f');
    const std::string &kind = f[0];

    if (kind == "S" && f.size() >= 2) {
      HMENU popup = CreatePopupMenu();
      if (!popup) continue;
      AppendMenuW(stack.back(), MF_POPUP,
                  reinterpret_cast<UINT_PTR>(popup),
                  widen(escape_mnemonics(f[1])).c_str());
      stack.push_back(popup);
    } else if (kind == "E") {
      if (stack.size() > 1) stack.pop_back();
    } else if (kind == "-") {
      if (stack.size() > 1) {
        AppendMenuW(stack.back(), MF_SEPARATOR, 0, nullptr);
      }
    } else if (kind == "I" && f.size() >= 8 && stack.size() > 1) {
      // The host owns the tag: it indexes the handler registry in TypeScript,
      // so the numbering comes from there rather than from insertion order.
      long tag = strtol(f[1].c_str(), nullptr, 10);
      UINT id = kIdItemBase + static_cast<UINT>(tag);
      WORD vk = 0;
      std::string shown;
      std::string label = escape_mnemonics(f[2]);
      unsigned long mods = strtoul(f[4].c_str(), nullptr, 10);
      if (!f[3].empty() && vk_for_key(f[3], vk, shown)) {
        label += "\t" + accel_text(shown, mods);
        ACCEL ac{};
        ac.fVirt = FVIRTKEY;
        if (mods & (1 | 8)) ac.fVirt |= FCONTROL;
        if (mods & 2) ac.fVirt |= FSHIFT;
        if (mods & 4) ac.fVirt |= FALT;
        ac.key = vk;
        ac.cmd = static_cast<WORD>(id);
        accels.push_back(ac);
      }
      UINT flags = MF_STRING;
      if (f[5] != "1") flags |= MF_GRAYED;
      if (f[6] == "1") flags |= MF_CHECKED;
      AppendMenuW(stack.back(), flags, id, widen(label).c_str());
      // The owning popup, not the bar: EnableMenuItem searches submenus by
      // command but SetMenuItemInfoW does not, and setLabel needs the latter.
      if (tag >= 0) {
        size_t at = static_cast<size_t>(tag);
        if (a->menu_items.size() <= at) a->menu_items.resize(at + 1, nullptr);
        a->menu_items[at] = stack.back();
      }
    }
  }

  if (!SetMenu(hwnd, bar)) {
    DestroyMenu(bar);
    return -1;
  }
  // Destroying the previous bar only after the new one is installed: it is
  // still the window's menu until SetMenu returns.
  if (g_menu_bar && g_menu_bar != bar) DestroyMenu(g_menu_bar);
  g_menu_bar = bar;
  DrawMenuBar(hwnd);
  // A menu bar takes a row out of the client area, and webview.h sizes its
  // widget only from WM_SIZE — which SetMenu does not send. Without this the
  // webview keeps its old height and the bottom of the page is clipped off
  // the window. SWP_FRAMECHANGED forces the WM_NCCALCSIZE/WM_SIZE pair.
  SetWindowPos(hwnd, nullptr, 0, 0, 0, 0,
               SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOOWNERZORDER |
                   SWP_FRAMECHANGED);

  if (g_accel) {
    DestroyAcceleratorTable(g_accel);
    g_accel = nullptr;
  }
  if (!accels.empty()) {
    g_accel = CreateAcceleratorTableW(accels.data(),
                                      static_cast<int>(accels.size()));
  }

  if (g_menu_hwnd != hwnd) {
    g_prev_wndproc = reinterpret_cast<WNDPROC>(SetWindowLongPtrW(
        hwnd, GWLP_WNDPROC, reinterpret_cast<LONG_PTR>(menu_wndproc)));
    g_menu_hwnd = hwnd;
  }
  if (!g_accel_hook) {
    g_accel_hook = SetWindowsHookExW(WH_GETMESSAGE, accel_hook, nullptr,
                                     GetCurrentThreadId());
  }

  a->menu_set = true;
  claim_menu_owner(a);
  return 0;
}

static HMENU owner_menu(App *a, int32_t tag) {
  if (tag < 0 || static_cast<size_t>(tag) >= a->menu_items.size()) return nullptr;
  return static_cast<HMENU>(a->menu_items[static_cast<size_t>(tag)]);
}

static int32_t menu_set_enabled(App *a, int32_t tag, int32_t on) {
  HMENU m = owner_menu(a, tag);
  if (!m || !g_menu_hwnd) return -1;
  if (EnableMenuItem(m, kIdItemBase + static_cast<UINT>(tag),
                     MF_BYCOMMAND | (on ? MF_ENABLED : MF_GRAYED)) == -1) {
    return -1;
  }
  DrawMenuBar(g_menu_hwnd);
  return 0;
}

static int32_t menu_set_checked(App *a, int32_t tag, int32_t on) {
  HMENU m = owner_menu(a, tag);
  if (!m) return -1;
  return CheckMenuItem(m, kIdItemBase + static_cast<UINT>(tag),
                       MF_BYCOMMAND | (on ? MF_CHECKED : MF_UNCHECKED)) ==
                 static_cast<DWORD>(-1)
             ? -1
             : 0;
}

static int32_t menu_set_label(App *a, int32_t tag, const std::string &label) {
  HMENU m = owner_menu(a, tag);
  if (!m || !g_menu_hwnd) return -1;
  // The accelerator text lives after a tab in the same string, so replacing
  // the label has to keep whatever was there or the shortcut stops being
  // printed while it goes on working.
  wchar_t existing[512];
  std::wstring text = widen(escape_mnemonics(label));
  int n = GetMenuStringW(m, kIdItemBase + static_cast<UINT>(tag), existing,
                         512, MF_BYCOMMAND);
  if (n > 0) {
    std::wstring was(existing, static_cast<size_t>(n));
    size_t tab = was.find(L'\t');
    if (tab != std::wstring::npos) text += was.substr(tab);
  }
  MENUITEMINFOW mii{};
  mii.cbSize = sizeof(mii);
  mii.fMask = MIIM_STRING;
  mii.dwTypeData = const_cast<wchar_t *>(text.c_str());
  if (!SetMenuItemInfoW(m, kIdItemBase + static_cast<UINT>(tag), FALSE, &mii)) {
    return -1;
  }
  DrawMenuBar(g_menu_hwnd);
  return 0;
}

static void menu_teardown(App *) {
  if (g_accel_hook) {
    UnhookWindowsHookEx(g_accel_hook);
    g_accel_hook = nullptr;
  }
  if (g_accel) {
    DestroyAcceleratorTable(g_accel);
    g_accel = nullptr;
  }
  // The menu bar is destroyed with the window; g_menu_bar is only cleared so
  // a later setMenu does not free a handle Windows already reclaimed.
  g_menu_bar = nullptr;
  g_menu_hwnd = nullptr;
  g_prev_wndproc = nullptr;
}

static void menu_realize(App *) {}


static bool platform_is_fullscreen(void *) { return g_win_fullscreen; }

static int32_t platform_set_fullscreen(void *win, bool on) {
  HWND hwnd = static_cast<HWND>(win);
  static WINDOWPLACEMENT saved = {sizeof(saved), 0, 0, {0, 0}, {0, 0}, {0, 0, 0, 0}};
  LONG_PTR style = GetWindowLongPtrW(hwnd, GWL_STYLE);
  if (on) {
    MONITORINFO mi;
    mi.cbSize = sizeof(mi);
    if (!GetWindowPlacement(hwnd, &saved) ||
        !GetMonitorInfoW(MonitorFromWindow(hwnd, MONITOR_DEFAULTTOPRIMARY), &mi)) {
      return -1;
    }
    SetWindowLongPtrW(hwnd, GWL_STYLE, style & ~WS_OVERLAPPEDWINDOW);
    SetWindowPos(hwnd, HWND_TOP, mi.rcMonitor.left, mi.rcMonitor.top,
                 mi.rcMonitor.right - mi.rcMonitor.left,
                 mi.rcMonitor.bottom - mi.rcMonitor.top,
                 SWP_NOOWNERZORDER | SWP_FRAMECHANGED);
  } else {
    SetWindowLongPtrW(hwnd, GWL_STYLE, style | WS_OVERLAPPEDWINDOW);
    SetWindowPlacement(hwnd, &saved);
    SetWindowPos(hwnd, nullptr, 0, 0, 0, 0,
                 SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOOWNERZORDER |
                     SWP_FRAMECHANGED);
  }
  g_win_fullscreen = on;
  return 0;
}

#else  // GTK

// ---- GTK menus -------------------------------------------------------------
//
// As on Windows there is no standard bar to install: WebKitGTK handles the
// editing keys itself, and closing the window is the window manager's job. A
// menu here is a feature the app asked for.
static void install_main_menu() {}

#if GTK_MAJOR_VERSION >= 4
// GTK 4 removed GtkMenuBar outright — menus there are GMenuModel, a different
// model with a different lifetime. The build pins gtk+-3.0 (bin/janela.mjs),
// so this is a compile-out rather than a guess at code nobody has run.
static int32_t apply_custom_menu(App *, const std::string &) { return -1; }
static int32_t menu_set_enabled(App *, int32_t, int32_t) { return -1; }
static int32_t menu_set_checked(App *, int32_t, int32_t) { return -1; }
static int32_t menu_set_label(App *, int32_t, const std::string &) { return -1; }
static int32_t perform_action(const std::string &) { return -1; }
static void menu_teardown(App *) {}
static void menu_realize(App *) {}
#else

static GtkAccelGroup *g_accel_group = nullptr;
// Set when the webview was not parented yet at setMenu time — see attach_menubar.
static std::string g_pending_spec;
static bool g_menu_pending = false;

static WebKitWebView *webkit_of(App *a) {
  if (!a || !a->w) return nullptr;
  void *h = webview_get_native_handle(
      a->w, WEBVIEW_NATIVE_HANDLE_KIND_BROWSER_CONTROLLER);
  return h ? WEBKIT_WEB_VIEW(h) : nullptr;
}

static int32_t perform_action(const std::string &action) {
  App *a = current_app();
  if (!a || !a->w) return -1;
  GtkWindow *window = GTK_WINDOW(webview_get_window(a->w));
  if (!window) return -1;

  // WebKitGTK does expose the editing commands, unlike WebView2 — which is
  // why Copy and Paste are real menu items on Linux and refusals on Windows.
  // The names are the literal strings behind the WEBKIT_EDITING_COMMAND_*
  // macros, spelled out so a webkit2gtk without the newer macro still builds.
  static const struct { const char *action; const char *command; } edits[] = {
      {"cut", "Cut"},   {"copy", "Copy"},   {"paste", "Paste"},
      {"undo", "Undo"}, {"redo", "Redo"},   {"selectAll", "SelectAll"},
  };
  for (const auto &e : edits) {
    if (action != e.action) continue;
    WebKitWebView *wv = webkit_of(a);
    if (!wv) return -1;
    webkit_web_view_execute_editing_command(wv, e.command);
    return 0;
  }

  // gtk_window_close, not gtk_main_quit: it unwinds through the same path the
  // title bar's close button uses, so the host returns from wv_run.
  if (action == "quit" || action == "closeWindow") {
    gtk_window_close(window);
    return 0;
  }
  if (action == "minimize") {
    gtk_window_iconify(window);
    return 0;
  }
  if (action == "zoom") {
    if (gtk_window_is_maximized(window)) {
      gtk_window_unmaximize(window);
    } else {
      gtk_window_maximize(window);
    }
    return 0;
  }
  if (action == "fullscreen") {
    platform_set_fullscreen(window, !platform_is_fullscreen(window));
    return 0;
  }
  if (action == "about") {
    // GTK's own About dialog, which is what a Linux user expects here for the
    // same reason macOS shows NSApplication's. Unlike Windows' ShellAboutW it
    // spins no nested loop — it presents and returns — so it is safe to call
    // with the menu handler's TypeScript frame still beneath us.
    //
    // The program name is what macOS's application menu shows, by the nearest
    // route Linux has: GTK sets it from argv[0] during init.
    const char *name = g_get_prgname();
    gtk_show_about_dialog(window, "program-name", name ? name : "App", NULL);
    return 0;
  }

  // hide, hideOthers and showAll are what is left, and they are not a missing
  // API but a missing CONCEPT. macOS hide is application state — windows
  // vanish, the app stays in the Dock, one click brings it back. Hiding a GTK
  // window instead takes it out of the taskbar with no way back short of a
  // tray icon, and there is no desktop-wide "hide others" to call: that is the
  // window manager's business, and on Wayland not even that. False beats a
  // dead menu entry.
  return -1;
}

static void on_item_activate(GtkMenuItem *, gpointer data) {
  menu_clicked(static_cast<long>(reinterpret_cast<intptr_t>(data)));
}

// Turns the host's symbolic modifiers and key name into something
// gtk_accelerator_parse understands. <Primary> is GTK's own name for "Control
// here, Command on a Mac", which is exactly MOD_PRIMARY.
static bool gtk_accel_for(const std::string &key, unsigned long mods,
                          guint &out_key, GdkModifierType &out_mods) {
  if (key.empty()) return false;
  std::string spec;
  if (mods & 1) spec += "<Primary>";
  if (mods & 8) spec += "<Control>";
  if (mods & 4) spec += "<Alt>";
  if (mods & 2) spec += "<Shift>";
  if (mods & 16) spec += "<Super>";  // Cmd, explicitly; Super is the nearest thing

  // GDK key names are case-sensitive ("F5", "Return"), and the host lowercases
  // everything. Single characters are already right; named keys need their own
  // spelling, and "Page_Up" is not a capitalisation of "pageup".
  static const struct { const char *name; const char *gdk; } named[] = {
      {"enter", "Return"},     {"return", "Return"},
      {"escape", "Escape"},    {"esc", "Escape"},
      {"space", "space"},      {"tab", "Tab"},
      {"backspace", "BackSpace"},
      {"delete", "Delete"},    {"del", "Delete"},
      {"insert", "Insert"},    {"up", "Up"},
      {"down", "Down"},        {"left", "Left"},
      {"right", "Right"},      {"home", "Home"},
      {"end", "End"},          {"pageup", "Page_Up"},
      {"pagedown", "Page_Down"},
  };
  std::string name = key;
  if (key.size() > 1) {
    bool found = false;
    for (const auto &n : named) {
      if (key == n.name) { name = n.gdk; found = true; break; }
    }
    if (!found) {
      // F1-F24 and anything else that is just the lowercase of its GDK name.
      name[0] = static_cast<char>(std::toupper(
          static_cast<unsigned char>(name[0])));
    }
  }
  spec += name;
  out_key = 0;
  out_mods = static_cast<GdkModifierType>(0);
  gtk_accelerator_parse(spec.c_str(), &out_key, &out_mods);
  return out_key != 0;
}

// Puts the bar above the webview.
//
// The GTK backend does gtk_container_add(window, webview) — a GtkWindow is a
// GtkBin and holds exactly one child — so a menu bar means re-parenting the
// webview into a box first. That is done once and remembered on the box, so a
// later setMenu swaps the bar rather than nesting another box.
//
// It can also arrive too early: the backend parents the webview lazily, in
// window_show(), which runs on the first webview_set_size. Adding our box to
// an empty window then would leave window_show() adding the webview to a
// GtkBin that is already full — a GTK warning and a blank window. So an
// unparented window means "not yet", and wv_run retries once setup is done.
static bool attach_menubar(App *a, GtkWidget *bar) {
  GtkWidget *window = GTK_WIDGET(webview_get_window(a->w));
  if (!window) return false;
  GtkWidget *child = gtk_bin_get_child(GTK_BIN(window));
  if (!child) return false;

  GtkWidget *box = nullptr;
  if (GTK_IS_BOX(child) &&
      g_object_get_data(G_OBJECT(child), "janela-menu-box")) {
    box = child;
    GtkWidget *old = GTK_WIDGET(
        g_object_get_data(G_OBJECT(box), "janela-menubar"));
    if (old) gtk_container_remove(GTK_CONTAINER(box), old);
  } else {
    g_object_ref(child);
    gtk_container_remove(GTK_CONTAINER(window), child);
    box = gtk_box_new(GTK_ORIENTATION_VERTICAL, 0);
    g_object_set_data(G_OBJECT(box), "janela-menu-box", box);
    gtk_box_pack_end(GTK_BOX(box), child, TRUE, TRUE, 0);
    g_object_unref(child);
    gtk_container_add(GTK_CONTAINER(window), box);
    gtk_widget_show(box);
  }
  gtk_box_pack_start(GTK_BOX(box), bar, FALSE, FALSE, 0);
  gtk_box_reorder_child(GTK_BOX(box), bar, 0);
  g_object_set_data(G_OBJECT(box), "janela-menubar", bar);
  gtk_widget_show_all(bar);

  if (!g_accel_group) return true;
  GtkWindow *w = GTK_WINDOW(window);
  if (!g_object_get_data(G_OBJECT(window), "janela-accels")) {
    gtk_window_add_accel_group(w, g_accel_group);
    g_object_set_data(G_OBJECT(window), "janela-accels", g_accel_group);
  }
  return true;
}

static int32_t apply_custom_menu(App *a, const std::string &spec) {
  if (!a->w) return -1;

  // One accel group for the window's lifetime: gtk_window_add_accel_group is
  // not idempotent, so rebuilding the menu re-uses the group and only the
  // items inside it change.
  if (!g_accel_group) g_accel_group = gtk_accel_group_new();

  GtkWidget *bar = gtk_menu_bar_new();
  a->menu_items.clear();

  std::vector<GtkWidget *> stack;  // containers: the bar, then each open menu
  stack.push_back(bar);

  for (const std::string &line : split_on(spec, '\n')) {
    if (line.empty()) continue;
    std::vector<std::string> f = split_on(line, '\x1f');
    const std::string &kind = f[0];

    if (kind == "S" && f.size() >= 2) {
      GtkWidget *holder = gtk_menu_item_new_with_label(f[1].c_str());
      GtkWidget *menu = gtk_menu_new();
      gtk_menu_item_set_submenu(GTK_MENU_ITEM(holder), menu);
      gtk_menu_shell_append(GTK_MENU_SHELL(stack.back()), holder);
      stack.push_back(menu);
    } else if (kind == "E") {
      if (stack.size() > 1) stack.pop_back();
    } else if (kind == "-") {
      if (stack.size() > 1) {
        gtk_menu_shell_append(GTK_MENU_SHELL(stack.back()),
                              gtk_separator_menu_item_new());
      }
    } else if (kind == "I" && f.size() >= 8 && stack.size() > 1) {
      long tag = strtol(f[1].c_str(), nullptr, 10);
      // f[7] is why the wire carries "checkable" separately from "checked":
      // GTK decides this at construction — a tick needs GtkCheckMenuItem, a
      // different widget — where AppKit lets any item carry a state.
      const bool checkable = f[7] == "1";
      GtkWidget *it = checkable
                          ? gtk_check_menu_item_new_with_label(f[2].c_str())
                          : gtk_menu_item_new_with_label(f[2].c_str());
      if (checkable) {
        gtk_check_menu_item_set_active(GTK_CHECK_MENU_ITEM(it), f[6] == "1");
      }
      gtk_widget_set_sensitive(it, f[5] == "1");
      g_signal_connect(it, "activate", G_CALLBACK(on_item_activate),
                       reinterpret_cast<gpointer>(
                           static_cast<intptr_t>(tag)));
      guint akey = 0;
      GdkModifierType amods = static_cast<GdkModifierType>(0);
      if (gtk_accel_for(f[3], strtoul(f[4].c_str(), nullptr, 10), akey, amods)) {
        gtk_widget_add_accelerator(it, "activate", g_accel_group, akey, amods,
                                   GTK_ACCEL_VISIBLE);
      }
      gtk_menu_shell_append(GTK_MENU_SHELL(stack.back()), it);
      if (tag >= 0) {
        size_t at = static_cast<size_t>(tag);
        if (a->menu_items.size() <= at) a->menu_items.resize(at + 1, nullptr);
        a->menu_items[at] = g_object_ref_sink(it);
      }
    }
  }

  a->menu_set = true;
  claim_menu_owner(a);

  if (!attach_menubar(a, bar)) {
    // Too early. Hold the spec and rebuild at run, when the webview is
    // certain to be parented; the widgets built here are dropped rather than
    // kept, because their accelerators would otherwise fire twice.
    g_object_ref_sink(bar);
    g_object_unref(bar);
    for (void *w : a->menu_items) {
      if (w) g_object_unref(G_OBJECT(w));
    }
    a->menu_items.clear();
    g_pending_spec = spec;
    g_menu_pending = true;
  }
  return 0;
}

// The retry the note on attach_menubar describes. Called from wv_run, after
// setup has had its chance to size the window.
static void menu_realize(App *a) {
  if (!g_menu_pending) return;
  g_menu_pending = false;
  const std::string spec = g_pending_spec;
  g_pending_spec.clear();
  apply_custom_menu(a, spec);
}

static GtkWidget *item_at(App *a, int32_t tag) {
  if (tag < 0 || static_cast<size_t>(tag) >= a->menu_items.size()) return nullptr;
  return GTK_WIDGET(a->menu_items[static_cast<size_t>(tag)]);
}

static int32_t menu_set_enabled(App *a, int32_t tag, int32_t on) {
  GtkWidget *it = item_at(a, tag);
  if (!it) return -1;
  gtk_widget_set_sensitive(it, on != 0);
  return 0;
}

static int32_t menu_set_checked(App *a, int32_t tag, int32_t on) {
  GtkWidget *it = item_at(a, tag);
  if (!it || !GTK_IS_CHECK_MENU_ITEM(it)) return -1;
  // set_active emits "activate", which would run the item's own click handler
  // as a side effect of the host setting the tick. Blocking the handler for
  // the duration is the difference between reflecting state and inventing a
  // click.
  g_signal_handlers_block_matched(G_OBJECT(it), G_SIGNAL_MATCH_FUNC, 0, 0,
                                  nullptr,
                                  reinterpret_cast<gpointer>(on_item_activate),
                                  nullptr);
  gtk_check_menu_item_set_active(GTK_CHECK_MENU_ITEM(it), on != 0);
  g_signal_handlers_unblock_matched(
      G_OBJECT(it), G_SIGNAL_MATCH_FUNC, 0, 0, nullptr,
      reinterpret_cast<gpointer>(on_item_activate), nullptr);
  return 0;
}

static int32_t menu_set_label(App *a, int32_t tag, const std::string &label) {
  GtkWidget *it = item_at(a, tag);
  if (!it) return -1;
  gtk_menu_item_set_label(GTK_MENU_ITEM(it), label.c_str());
  return 0;
}

static void menu_teardown(App *a) {
  for (void *w : a->menu_items) {
    if (w) g_object_unref(G_OBJECT(w));
  }
  a->menu_items.clear();
  g_menu_pending = false;
  g_pending_spec.clear();
}

#endif  // GTK_MAJOR_VERSION >= 4

// Asks the window manager rather than remembering what we last asked for: a
// GTK window can leave fullscreen without us (the WM's own keybinding), and a
// toggle that trusts a stale flag then does the wrong thing.
static bool platform_is_fullscreen(void *win) {
#if GTK_MAJOR_VERSION >= 4
  return gtk_window_is_fullscreen(GTK_WINDOW(win));
#else
  GdkWindow *gdk = gtk_widget_get_window(GTK_WIDGET(win));
  if (!gdk) return false;
  return (gdk_window_get_state(gdk) & GDK_WINDOW_STATE_FULLSCREEN) != 0;
#endif
}

static int32_t platform_set_fullscreen(void *win, bool on) {
  GtkWindow *window = GTK_WINDOW(win);
  if (on) {
    gtk_window_fullscreen(window);
  } else {
    gtk_window_unfullscreen(window);
  }
  return 0;
}

#endif

// Runs on the UI thread with no TS frame beneath it — see the note on the job
// pool above for why that matters.
void dialog_on_ui_thread(webview_t, void *arg) {
  std::unique_ptr<DialogRequest> req(static_cast<DialogRequest *>(arg));
  Job *j = job_at(req->job);
  if (!j) return;
  std::vector<std::string> picked;
  std::string error;
  bool ok = run_file_dialog(*req, picked, error);
  if (!error.empty()) {
    job_finish(j, JOB_ERROR, error);
    return;
  }
  // A cancel is a successful call that answers `null`, not a failure.
  job_finish(j, JOB_OK, ok ? json_array(picked) : "null");
}

// The single C trampoline registered with webview_bind. `arg` is the app
// index; every binding routes to the one retained invoke handler.
void trampoline(const char *id, const char *req, void *arg) {
  App *a = &g_apps[reinterpret_cast<uintptr_t>(arg)];

  if (!a->on_invoke) return;  // no TS handler installed

  a->req = req ? req : "";
  a->cur_id = id ? id : "";
  a->reply.clear();
  a->deferred = false;
  a->seq++;

  // Re-entrancy: this call lands back in TS, which calls wv_reply() back into
  // this shim before returning.
  int32_t status = a->on_invoke(
      reinterpret_cast<const uint8_t *>(a->req.data()), a->req.size(),
      a->on_invoke_ctx);

  // An async handler called wv_defer(): the call id now lives in the pending
  // table and wv_resolve() will answer the page later. Returning now would
  // settle the promise with a stale value.
  if (a->deferred) {
    a->deferred = false;
    a->cur_id.clear();
    return;
  }

  webview_return(a->w, a->cur_id.c_str(), status,
                 a->reply.empty() ? "null" : a->reply.c_str());
  // wv_defer() treats a non-empty cur_id as "an invoke is in flight". Clearing
  // it here means a defer from anywhere else — a timer, say — fails with -1
  // instead of stealing this already-answered call's id.
  a->cur_id.clear();
}

// The app index and the timer id, packed into the single void* that
// webview_dispatch carries.
void *pack_timer(int32_t app, int32_t id) {
  uintptr_t packed = (static_cast<uintptr_t>(static_cast<uint32_t>(app)) << 32) |
                     static_cast<uint32_t>(id);
  return reinterpret_cast<void *>(packed);
}

// Runs on the UI thread, posted via webview_dispatch, so the TS it calls stays
// single-threaded — scriptc's runtime is NOT thread-safe.
//
// This is also the one place that guarantees the shell never re-enters TS from
// inside a frame TS is already in. Everything that wants to reach TS — a due
// timer, a finished file read, a dismissed dialog — goes through a dispatch
// and therefore lands at the top of a later turn, with no TS beneath it. That
// rule is invisible when broken: a violating host gets correct-looking results
// right up until it doesn't, so it is kept by construction, not by testing.
void timer_on_ui_thread(webview_t, void *arg) {
  uintptr_t packed = reinterpret_cast<uintptr_t>(arg);
  App *a = &g_apps[packed >> 32];
  int32_t id = static_cast<int32_t>(static_cast<uint32_t>(packed & 0xffffffffu));
  if (!a->used || !a->on_timer) return;  // app quit between dispatch and delivery
  a->seq++;
  a->on_timer(id, a->on_timer_ctx);
}

void post_timer(int32_t app, int32_t id) {
  if (app < 0 || app >= 8) return;
  App *a = &g_apps[app];
  if (!a->used || !a->w) return;
  webview_dispatch(a->w, timer_on_ui_thread, pack_timer(app, id));
}

// The scheduler thread: sleep until the earliest timer is due, hand its id to
// the UI thread, repeat. It never touches TS and holds no TS state.
void scheduler_loop(App *a, int32_t h) {
  std::unique_lock<std::mutex> lk(a->timers_mu);
  while (a->scheduling.load()) {
    if (a->timers.empty()) {
      a->timers_cv.wait(lk);
      continue;
    }
    auto soonest = std::min_element(
        a->timers.begin(), a->timers.end(),
        [](const Timer &x, const Timer &y) { return x.due < y.due; });
    auto due = soonest->due;
    if (due > std::chrono::steady_clock::now()) {
      a->timers_cv.wait_until(lk, due);
      continue;  // re-check: an earlier timer may have arrived meanwhile
    }
    int32_t id = soonest->id;
    a->timers.erase(soonest);
    lk.unlock();
    post_timer(h, id);
    lk.lock();
  }
}

}  // namespace

extern "C" {

int32_t wv_create(int32_t debug) {
  for (int32_t i = 0; i < 8; i++) {
    if (g_apps[i].used) continue;
    webview_t w = webview_create(debug, nullptr);
    if (!w) return -1;
    // The menu is not installed here: an app that calls setMenu owns the bar,
    // and one that never does gets the standard one at wv_run. Deciding at
    // create time would mean building a bar only to throw it away.
    // Field-wise reset: App holds a thread and atomics, so it is not
    // copy-assignable from a temporary.
    g_apps[i].binds.clear();
    g_apps[i].on_invoke = nullptr;
    g_apps[i].on_invoke_ctx = nullptr;
    g_apps[i].on_timer = nullptr;
    g_apps[i].on_timer_ctx = nullptr;
    g_apps[i].on_menu = nullptr;
    g_apps[i].on_menu_ctx = nullptr;
    g_apps[i].menu_items.clear();
    g_apps[i].menu_set = false;
    g_apps[i].req.clear();
    g_apps[i].cur_id.clear();
    g_apps[i].reply.clear();
    g_apps[i].seq = 0;
    g_apps[i].pending.clear();
    g_apps[i].deferred = false;
    g_apps[i].scheduling.store(false);
    g_apps[i].timers.clear();
    g_apps[i].w = w;
    g_apps[i].used = true;
    return i;
  }
  return -1;
}

int32_t wv_set_title(int32_t h, const uint8_t *p, size_t n) {
  App *a = app_at(h);
  if (!a) return -1;
  return webview_set_title(a->w, to_str(p, n).c_str());
}

int32_t wv_set_size(int32_t h, int32_t width, int32_t height, int32_t hint) {
  App *a = app_at(h);
  if (!a) return -1;
  return webview_set_size(a->w, width, height,
                          static_cast<webview_hint_t>(hint));
}

int32_t wv_set_html(int32_t h, const uint8_t *p, size_t n) {
  App *a = app_at(h);
  if (!a) return -1;
  return webview_set_html(a->w, to_str(p, n).c_str());
}

int32_t wv_navigate(int32_t h, const uint8_t *p, size_t n) {
  App *a = app_at(h);
  if (!a) return -1;
  return webview_navigate(a->w, to_str(p, n).c_str());
}

int32_t wv_init(int32_t h, const uint8_t *p, size_t n) {
  App *a = app_at(h);
  if (!a) return -1;
  return webview_init(a->w, to_str(p, n).c_str());
}

int32_t wv_eval(int32_t h, const uint8_t *p, size_t n) {
  App *a = app_at(h);
  if (!a) return -1;
  return webview_eval(a->w, to_str(p, n).c_str());
}

// Returns the bind index that wv_run's callback will receive.
int32_t wv_bind(int32_t h, const uint8_t *p, size_t n) {
  App *a = app_at(h);
  if (!a) return -1;
  size_t idx = a->binds.size();
  a->binds.push_back(Bind{to_str(p, n)});
  int rc = webview_bind(a->w, a->binds[idx].name.c_str(), trampoline,
                        reinterpret_cast<void *>(static_cast<uintptr_t>(h)));
  if (rc != WEBVIEW_ERROR_OK) return -1;
  return static_cast<int32_t>(idx);
}

// Stage the response body for the call being handled (or, after wv_defer, for
// the pending call that wv_resolve will answer). One call, whole payload.
int32_t wv_reply(int32_t h, const uint8_t *p, size_t n) {
  App *a = app_at(h);
  if (!a) return -1;
  a->reply.assign(reinterpret_cast<const char *>(p), n);
  return 0;
}

// ---- async: deferred returns + a UI-thread pump -----------------------------
//
// scriptc's own event loop does not run while the program sits inside an FFI
// call, and wv_run() is one such call for the app's whole life — so setTimeout
// and promise continuations in TS never fire while the window is open. These
// four functions supply the missing loop: TS may postpone an invoke's answer
// (wv_defer), answer it later (wv_resolve), and park a continuation with the
// shell to be called back on the UI thread when it comes due (wv_schedule).

// Postpone the answer to the invoke being handled right now. Returns a
// pending id to hand back to wv_resolve(), or -1 outside a bind callback.
int32_t wv_defer(int32_t h) {
  App *a = app_at(h);
  if (!a || a->cur_id.empty()) return -1;
  for (size_t i = 0; i < a->pending.size(); i++) {
    if (!a->pending[i].used) {
      a->pending[i].used = true;
      a->pending[i].call_id = a->cur_id;
      a->deferred = true;
      return static_cast<int32_t>(i);
    }
  }
  a->pending.push_back(Pending{true, a->cur_id});
  a->deferred = true;
  return static_cast<int32_t>(a->pending.size() - 1);
}

// Answer a deferred invoke with whatever TS has staged via wv_reply_push().
// status 0 resolves the page's promise, non-zero rejects it.
int32_t wv_resolve(int32_t h, int32_t id, int32_t status) {
  App *a = app_at(h);
  if (!a || id < 0 || static_cast<size_t>(id) >= a->pending.size()) return -1;
  Pending &p = a->pending[id];
  if (!p.used) return -1;
  webview_return(a->w, p.call_id.c_str(), status,
                 a->reply.empty() ? "null" : a->reply.c_str());
  p.used = false;
  p.call_id.clear();
  a->reply.clear();
  return 0;
}

// Ask the shell to call the retained timer handler with `id` after `ms`.
//
// This is the whole of scheduling: TS keeps the continuation, the shell keeps
// the clock. A zero delay is not a special case — it posts on the next turn of
// the loop, which is exactly what app.defer() wants, with no timer involved.
//
// An idle app now costs nothing at all: with no timers queued the scheduler
// thread blocks on a condition variable rather than waking every few
// milliseconds to find nothing to do.
int32_t wv_schedule(int32_t h, int32_t id, int32_t ms) {
  App *a = app_at(h);
  if (!a) return -1;

  // Zero delay skips the queue: there is nothing to wait for, and posting
  // straight to the UI thread keeps a defer() chain as short as possible.
  if (ms <= 0) {
    post_timer(h, id);
    return 0;
  }

  {
    std::lock_guard<std::mutex> lock(a->timers_mu);
    a->timers.push_back(
        Timer{id, std::chrono::steady_clock::now() +
                      std::chrono::milliseconds(ms)});
    if (!a->scheduling.exchange(true)) {
      a->scheduler = std::thread(scheduler_loop, a, h);
    }
  }
  a->timers_cv.notify_one();
  return 0;
}

// Stop the scheduler thread and drop any timers that never came due. Called on
// the way out of wv_run(), so nothing can reach TS after the window closes.
void stop_scheduler(App *a) {
  if (!a->scheduling.exchange(false)) return;
  a->timers_cv.notify_all();
  if (a->scheduler.joinable()) a->scheduler.join();
  std::lock_guard<std::mutex> lock(a->timers_mu);
  a->timers.clear();
}

// ---- async file I/O ---------------------------------------------------------
//
// wv_fs_read/wv_fs_write start a worker thread and return immediately with a
// job id. TS is woken with TIMER_JOBS when it finishes, reads wv_job_status()
// and drains the payload
// with wv_fs_byte() once the job is terminal. On failure the payload is the
// error message, so success and failure share one drain path.

int32_t wv_fs_read(int32_t h, const uint8_t *p, size_t n) {
  if (!app_at(h)) return -1;
  int32_t id = new_job(h);
  Job *j = job_at(id);
  if (!j) return -1;
  j->worker = std::thread(fs_read_worker, j, to_str(p, n));
  return id;
}

int32_t wv_fs_write(int32_t h, const uint8_t *p, size_t n, const uint8_t *dp,
                    size_t dn) {
  if (!app_at(h)) return -1;
  int32_t id = new_job(h);
  Job *j = job_at(id);
  if (!j) return -1;
  j->worker = std::thread(fs_write_worker, j, to_str(p, n), to_str(dp, dn));
  return id;
}

// 0 = still running, 1 = done, 2 = failed, -1 = no such job.
int32_t wv_job_status(int32_t h, int32_t id) {
  if (!app_at(h)) return -1;
  Job *j = job_at(id);
  if (!j) return -1;
  return j->status.load(std::memory_order_acquire);
}

// Payload size in bytes, so TS knows when it has drained the whole thing.
// f64 rather than i32: a payload may exceed 2 GB, and every scriptc number is
// a double anyway (exact for byte counts far beyond any plausible file).
double wv_job_size(int32_t h, int32_t id) {
  if (!app_at(h)) return -1;
  Job *j = job_at(id);
  if (!j) return -1;
  if (j->status.load(std::memory_order_acquire) == JOB_PENDING) return -1;
  return static_cast<double>(j->data.size());
}

// Hand ONE SLICE of a finished job's payload to TS, and answer how many bytes
// it covered. The callback is lifetime:"call", so it runs synchronously here —
// on the UI thread, the only thread allowed to touch the scriptc runtime. The
// worker is already done by then (the caller has observed a terminal status),
// so `data` is stable for the whole drain.
//
// Slicing exists so the UI thread can decode a large payload across several
// turns instead of stalling on all of it at once; the caller advances `offset`
// by the returned count until it reaches wv_job_size().
//
// The slice end is pulled back to a UTF-8 sequence boundary, because scriptc
// decodes a `string` param as UTF-8: cutting mid-sequence would turn one
// character into replacement characters on both sides of the seam. Bytes that
// are not valid UTF-8 have no boundary to find, so after four steps the cut
// stands as asked and the payload is passed through unchanged.
double wv_job_take_at(int32_t h, int32_t id, double offset, double max_bytes,
                      void (*sink)(const uint8_t *, size_t, void *),
                      void *ctx) {
  if (!app_at(h)) return -1;
  Job *j = job_at(id);
  if (!j || !sink) return -1;
  if (j->status.load(std::memory_order_acquire) == JOB_PENDING) return -1;
  if (offset < 0 || max_bytes < 0) return -1;

  const size_t size = j->data.size();
  const size_t off = static_cast<size_t>(offset);
  if (off > size) return -1;
  if (off == size) return 0;

  size_t want = static_cast<size_t>(max_bytes);
  if (want == 0) return 0;
  size_t end = off + want;
  if (end >= size) {
    end = size;
  } else {
    const unsigned char *d =
        reinterpret_cast<const unsigned char *>(j->data.data());
    // d[end] is the first byte of the NEXT slice; while it is a continuation
    // byte (10xxxxxx) the cut sits inside a character, so step back.
    size_t e = end;
    for (int guard = 0; guard < 4 && e > off && (d[e] & 0xc0) == 0x80; guard++) {
      e--;
    }
    if (e > off) end = e;
  }

  sink(reinterpret_cast<const uint8_t *>(j->data.data()) + off, end - off, ctx);
  return static_cast<double>(end - off);
}

// Release the slot for reuse. Refuses while the worker is still running, so a
// job's buffer can never be recycled out from under its own thread.
int32_t wv_job_free(int32_t h, int32_t id) {
  if (!app_at(h)) return -1;
  Job *j = job_at(id);
  if (!j) return -1;
  if (j->status.load(std::memory_order_acquire) == JOB_PENDING) return -1;
  std::lock_guard<std::mutex> lock(g_jobs_mu);
  if (j->worker.joinable()) j->worker.join();
  j->data.clear();
  j->data.shrink_to_fit();
  j->used = false;
  return 0;
}

// ---- native dialogs ---------------------------------------------------------

// Start a file dialog. Returns a job id immediately; the modal itself runs on
// a later UI-thread turn, so this never blocks the invoke that asked for it.
// The finished payload is a JSON array of paths, or `null` for a cancel.
int32_t wv_dialog(int32_t h, int32_t kind, int32_t flags, const uint8_t *tp,
                  size_t tn, const uint8_t *pp, size_t pn, const uint8_t *np,
                  size_t nn, const uint8_t *fp, size_t fn) {
  App *a = app_at(h);
  if (!a) return -1;
  int32_t id = new_job(h);
  Job *j = job_at(id);
  if (!j) return -1;

  DialogRequest *req = new DialogRequest();
  req->app = h;
  req->job = id;
  req->kind = kind;
  req->flags = flags;
  req->title = to_str(tp, tn);
  req->default_path = to_str(pp, pn);
  req->default_name = to_str(np, nn);
  req->filters = to_str(fp, fn);

  if (webview_dispatch(a->w, dialog_on_ui_thread, req) != WEBVIEW_ERROR_OK) {
    delete req;
    job_finish(j, JOB_ERROR, "EIO: could not post the dialog to the UI thread");
  }
  return id;
}

// ---- window control ---------------------------------------------------------

// Renders the host's declarative menu. The spec is one row per line with 0x1f
// between fields; the runtime flattens the tree, so nothing here parses JSON.
// Returns -1 where custom menus are not supported yet (everything but macOS),
// which the host reports rather than swallowing.
int32_t wv_set_menu(int32_t h, const uint8_t *p, size_t n) {
  App *a = app_at(h);
  if (!a) return -1;
  return apply_custom_menu(a, to_str(p, n));
}

// Retained, like wv_on_invoke: registered once and valid until the app exits.
int32_t wv_on_menu(int32_t h, int32_t (*cb)(int32_t, void *), void *ctx) {
  App *a = app_at(h);
  if (!a) return -1;
  a->on_menu = cb;
  a->on_menu_ctx = ctx;
  return 0;
}

// Change one live item without rebuilding the bar. The tag is the host's
// registry index, handed down by wv_set_menu. -1 for an unknown tag rather
// than silence, so a stale handle is visible instead of a no-op.
int32_t wv_menu_set_enabled(int32_t h, int32_t tag, int32_t on) {
  App *a = app_at(h);
  if (!a) return -1;
  return menu_set_enabled(a, tag, on);
}

int32_t wv_menu_set_checked(int32_t h, int32_t tag, int32_t on) {
  App *a = app_at(h);
  if (!a) return -1;
  return menu_set_checked(a, tag, on);
}

int32_t wv_menu_set_label(int32_t h, int32_t tag, const uint8_t *p, size_t n) {
  App *a = app_at(h);
  if (!a) return -1;
  return menu_set_label(a, tag, to_str(p, n));
}

// Run a platform action now — copy, paste, close, quit. Takes no handle
// because on macOS it needs none: the responder chain and the key window are
// process state. The other two resolve the window through current_app().
int32_t wv_perform_action(const uint8_t *p, size_t n) {
  return perform_action(to_str(p, n));
}

int32_t wv_set_fullscreen(int32_t h, int32_t on) {
  App *a = app_at(h);
  if (!a) return -1;
  void *win = webview_get_window(a->w);
  if (!win) return -1;
  return platform_set_fullscreen(win, on != 0);
}

// Register the retained handler for page invokes. Valid until the app exits.
int32_t wv_on_invoke(int32_t h,
                     int32_t (*cb)(const uint8_t *, size_t, void *),
                     void *ctx) {
  App *a = app_at(h);
  if (!a) return -1;
  a->on_invoke = cb;
  a->on_invoke_ctx = ctx;
  return 0;
}

// Register the retained handler the shell calls when a scheduled id comes due
// (and with TIMER_JOBS when a file read or dialog finishes).
int32_t wv_on_timer(int32_t h, void (*cb)(int32_t, void *), void *ctx) {
  App *a = app_at(h);
  if (!a) return -1;
  a->on_timer = cb;
  a->on_timer_ctx = ctx;
  return 0;
}

// Blocks for the app's lifetime, dispatching into the retained handlers.
int32_t wv_run(int32_t h) {
  App *a = app_at(h);
  if (!a) return -1;
  // The floor: an app that never set a menu still gets Cmd+Q and Cmd+V. By
  // now setup() has run, so this is the first moment it is knowable. A no-op
  // off macOS, where those keys need no menu.
  if (!a->menu_set) {
    install_main_menu();
  } else {
    // A renderer that could not attach during setup gets its second chance
    // here — see attach_menubar in the GTK section. A no-op elsewhere.
    menu_realize(a);
  }
  int rc = webview_run(a->w);
  // Nothing may call into TS once run() has returned.
  stop_scheduler(a);
  jobs_join_all();  // nor may an in-flight read outlive the app
  a->on_invoke = nullptr;
  a->on_timer = nullptr;
  return rc;
}

int32_t wv_terminate(int32_t h) {
  App *a = app_at(h);
  if (!a) return -1;
  return webview_terminate(a->w);
}

int32_t wv_destroy(int32_t h) {
  App *a = app_at(h);
  if (!a) return -1;
  stop_scheduler(a);
  menu_teardown(a);
  webview_destroy(a->w);
  a->used = false;
  a->w = nullptr;
  return 0;
}

}  // extern "C"
