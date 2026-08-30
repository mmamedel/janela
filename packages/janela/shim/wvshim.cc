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
//   * format 4 — callbacks may be `retained`, so the invoke and tick handlers
//     are registered once and live for the app's lifetime. wv_run() is a plain
//     blocking call again; it no longer has to carry a callback whose "call
//     scope" was standing in for "app lifetime".

#include "webview.h"

#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstdio>
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
#elif !defined(__APPLE__)
#include <gtk/gtk.h>
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

struct App {
  webview_t w = nullptr;
  bool used = false;
  std::vector<Bind> binds;

  // Retained TS handlers, registered once and valid until the app exits. The
  // request rides in as a (ptr, len) string param.
  int32_t (*on_invoke)(const uint8_t *, size_t, void *) = nullptr;
  void *on_invoke_ctx = nullptr;
  void (*on_tick)(void *) = nullptr;
  void *on_tick_ctx = nullptr;

  // Staging for the in-flight request.
  std::string req;      // JSON args array from JS
  std::string cur_id;   // webview's call id, needed by webview_return
  std::string reply;    // response body handed over by TS in one call
  uint32_t seq = 0;

  // ---- async support ----
  std::vector<Pending> pending;  // deferred invokes, addressed by index
  bool deferred = false;         // set by wv_defer() during the current call
  std::thread ticker;            // pure-C++ thread; never touches TS itself
  std::atomic<bool> ticking{false};
  std::atomic<int32_t> tick_ms{16};
};

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
// call that asks for it. TS starts one, gets an id back immediately, and polls
// wv_job_status() from its tick loop until the job is terminal.
//
// Two kinds use this pool, for opposite reasons:
//   * file I/O — the blocking syscall must happen off the UI thread, so a
//     worker thread does it. A worker touches only its own job and NEVER calls
//     into TS: scriptc's runtime is not thread-safe, so the result is drained
//     later, on the UI thread.
//   * native dialogs — the modal must run ON the UI thread, but not while TS
//     is on the stack (runModal/gtk_dialog_run spin a nested event loop, which
//     would re-enter the tick handler underneath the invoke handler that asked
//     for the dialog). So the job is posted with webview_dispatch and runs at
//     the top of a later turn, with no TS frame beneath it.

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
int32_t new_job() {
  std::lock_guard<std::mutex> lock(g_jobs_mu);
  for (size_t i = 0; i < g_jobs.size(); i++) {
    if (g_jobs[i]->used) continue;
    if (g_jobs[i]->worker.joinable()) g_jobs[i]->worker.join();
    g_jobs[i]->status.store(JOB_PENDING);
    g_jobs[i]->data.clear();
    g_jobs[i]->used = true;
    return static_cast<int32_t>(i);
  }
  g_jobs.push_back(std::unique_ptr<Job>(new Job()));
  g_jobs.back()->used = true;
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

void job_finish(Job *j, int32_t status, std::string payload) {
  j->data = std::move(payload);
  j->status.store(status, std::memory_order_release);
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

#if defined(__APPLE__)

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
  // it here means a defer from anywhere else — a tick, say — fails with -1
  // instead of stealing this already-answered call's id.
  a->cur_id.clear();
}

// Runs on the UI thread (posted by the ticker via webview_dispatch), so the
// TS it calls stays single-threaded — scriptc's runtime is NOT thread-safe.
void tick_on_ui_thread(webview_t, void *arg) {
  App *a = &g_apps[reinterpret_cast<uintptr_t>(arg)];
  if (!a->used || !a->on_tick) return;  // app quit between dispatch and delivery
  a->seq++;
  a->on_tick(a->on_tick_ctx);
}

}  // namespace

extern "C" {

int32_t wv_create(int32_t debug) {
  for (int32_t i = 0; i < 8; i++) {
    if (g_apps[i].used) continue;
    webview_t w = webview_create(debug, nullptr);
    if (!w) return -1;
    // Field-wise reset: App holds a thread and atomics, so it is not
    // copy-assignable from a temporary.
    g_apps[i].binds.clear();
    g_apps[i].on_invoke = nullptr;
    g_apps[i].on_invoke_ctx = nullptr;
    g_apps[i].on_tick = nullptr;
    g_apps[i].on_tick_ctx = nullptr;
    g_apps[i].req.clear();
    g_apps[i].cur_id.clear();
    g_apps[i].reply.clear();
    g_apps[i].seq = 0;
    g_apps[i].pending.clear();
    g_apps[i].deferred = false;
    g_apps[i].ticking.store(false);
    g_apps[i].tick_ms.store(16);
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
// (wv_defer), answer it later (wv_resolve), and get called back periodically
// on the UI thread to make progress (wv_tick_start / wv_tick_stop).

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

// Start pumping the retained tick handler every interval_ms. The thread
// itself only sleeps and posts; all TS execution happens on the UI thread.
int32_t wv_tick_start(int32_t h, int32_t interval_ms) {
  App *a = app_at(h);
  if (!a) return -1;
  a->tick_ms = interval_ms > 0 ? interval_ms : 16;
  if (a->ticking.exchange(true)) return 0;  // already running
  uintptr_t idx = static_cast<uintptr_t>(h);
  a->ticker = std::thread([a, idx]() {
    while (a->ticking.load()) {
      std::this_thread::sleep_for(
          std::chrono::milliseconds(a->tick_ms.load()));
      if (!a->ticking.load()) break;
      webview_dispatch(a->w, tick_on_ui_thread, reinterpret_cast<void *>(idx));
    }
  });
  return 0;
}

int32_t wv_tick_stop(int32_t h) {
  App *a = app_at(h);
  if (!a) return -1;
  if (!a->ticking.exchange(false)) return 0;
  if (a->ticker.joinable()) a->ticker.join();
  return 0;
}

// ---- async file I/O ---------------------------------------------------------
//
// wv_fs_read/wv_fs_write start a worker thread and return immediately with a
// job id. TS polls wv_job_status() from its tick loop and drains the payload
// with wv_fs_byte() once the job is terminal. On failure the payload is the
// error message, so success and failure share one drain path.

int32_t wv_fs_read(int32_t h, const uint8_t *p, size_t n) {
  if (!app_at(h)) return -1;
  int32_t id = new_job();
  Job *j = job_at(id);
  if (!j) return -1;
  j->worker = std::thread(fs_read_worker, j, to_str(p, n));
  return id;
}

int32_t wv_fs_write(int32_t h, const uint8_t *p, size_t n, const uint8_t *dp,
                    size_t dn) {
  if (!app_at(h)) return -1;
  int32_t id = new_job();
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
  int32_t id = new_job();
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

int32_t wv_set_fullscreen(int32_t h, int32_t on) {
  App *a = app_at(h);
  if (!a) return -1;
  void *win = webview_get_window(a->w);
  if (!win) return -1;

#if defined(__APPLE__)
  using namespace webview::detail;
  objc::autoreleasepool arp;
  id window = static_cast<id>(win);
  // NSWindowStyleMaskFullScreen. toggleFullScreen: only toggles, so read the
  // current state first and leave it alone when it already matches.
  const NSUInteger full = 1UL << 14;
  NSUInteger mask = objc::msg_send<NSUInteger>(window, objc::selector("styleMask"));
  bool is_full = (mask & full) != 0;
  if (is_full != (on != 0)) {
    objc::msg_send<void>(window, objc::selector("toggleFullScreen:"), nullptr);
  }
  return 0;
#elif defined(_WIN32)
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
  return 0;
#else
  GtkWindow *window = GTK_WINDOW(win);
  if (on) {
    gtk_window_fullscreen(window);
  } else {
    gtk_window_unfullscreen(window);
  }
  return 0;
#endif
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

// Register the retained handler the ticker pumps on the UI thread.
int32_t wv_on_tick(int32_t h, void (*cb)(void *), void *ctx) {
  App *a = app_at(h);
  if (!a) return -1;
  a->on_tick = cb;
  a->on_tick_ctx = ctx;
  return 0;
}

// Blocks for the app's lifetime, dispatching into the retained handlers.
int32_t wv_run(int32_t h) {
  App *a = app_at(h);
  if (!a) return -1;
  int rc = webview_run(a->w);
  // Nothing may call into TS once run() has returned.
  a->ticking.store(false);
  if (a->ticker.joinable()) a->ticker.join();
  jobs_join_all();  // nor may an in-flight read outlive the app
  a->on_invoke = nullptr;
  a->on_tick = nullptr;
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
  a->ticking.store(false);
  if (a->ticker.joinable()) a->ticker.join();
  webview_destroy(a->w);
  a->used = false;
  a->w = nullptr;
  return 0;
}

}  // extern "C"
