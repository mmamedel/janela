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
#include <cstring>
#include <filesystem>
#include <fstream>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

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

// ---- file I/O jobs ---------------------------------------------------------
//
// The whole point of this subsystem is that the blocking syscall happens HERE,
// on a worker thread, and never on the UI thread. A worker touches only its
// own job and never calls into TS — scriptc's runtime is not thread-safe, so
// results cross back on the UI thread, drained by the tick loop.

const int32_t FS_PENDING = 0;
const int32_t FS_OK = 1;
const int32_t FS_ERROR = 2;

struct FsJob {
  // Written by the worker before `status` flips; read by the UI thread only
  // after it observes a terminal status. The release/acquire pair on `status`
  // is what publishes `data`, so no lock is needed for the payload itself.
  std::atomic<int32_t> status{FS_PENDING};
  std::string data;  // file contents on success, the error message on failure
  std::thread worker;
  bool used = false;
};

// Jobs are addressed by index and held behind unique_ptr so the vector may
// grow without invalidating a worker's pointer to its own job.
std::mutex g_fs_mu;
std::vector<std::unique_ptr<FsJob>> g_fs_jobs;

FsJob *fs_job_at(int32_t id) {
  std::lock_guard<std::mutex> lock(g_fs_mu);
  if (id < 0 || static_cast<size_t>(id) >= g_fs_jobs.size()) return nullptr;
  FsJob *j = g_fs_jobs[id].get();
  return j->used ? j : nullptr;
}

// Reuses a finished slot when one is free, so a long-running app that reads
// many files does not grow the table without bound.
int32_t fs_new_job() {
  std::lock_guard<std::mutex> lock(g_fs_mu);
  for (size_t i = 0; i < g_fs_jobs.size(); i++) {
    if (g_fs_jobs[i]->used) continue;
    if (g_fs_jobs[i]->worker.joinable()) g_fs_jobs[i]->worker.join();
    g_fs_jobs[i]->status.store(FS_PENDING);
    g_fs_jobs[i]->data.clear();
    g_fs_jobs[i]->used = true;
    return static_cast<int32_t>(i);
  }
  g_fs_jobs.push_back(std::unique_ptr<FsJob>(new FsJob()));
  g_fs_jobs.back()->used = true;
  return static_cast<int32_t>(g_fs_jobs.size() - 1);
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

void fs_finish(FsJob *j, int32_t status, std::string payload) {
  j->data = std::move(payload);
  j->status.store(status, std::memory_order_release);
}

void fs_read_worker(FsJob *j, std::string path) {
  std::error_code ec;
  if (std::filesystem::is_directory(path, ec)) {
    fs_finish(j, FS_ERROR, fs_error_message(path, "read"));
    return;
  }
  std::ifstream in(path, std::ios::binary);
  if (!in) {
    fs_finish(j, FS_ERROR, fs_error_message(path, "open"));
    return;
  }
  std::string buf((std::istreambuf_iterator<char>(in)),
                  std::istreambuf_iterator<char>());
  if (in.bad()) {
    fs_finish(j, FS_ERROR, fs_error_message(path, "read"));
    return;
  }
  fs_finish(j, FS_OK, std::move(buf));
}

void fs_write_worker(FsJob *j, std::string path, std::string data) {
  std::ofstream out(path, std::ios::binary | std::ios::trunc);
  if (!out) {
    fs_finish(j, FS_ERROR, fs_error_message(path, "open"));
    return;
  }
  out.write(data.data(), static_cast<std::streamsize>(data.size()));
  out.flush();
  if (!out) {
    fs_finish(j, FS_ERROR, fs_error_message(path, "write"));
    return;
  }
  fs_finish(j, FS_OK, std::string());
}

// Join every worker. Called at shutdown so no thread outlives the process's
// orderly exit (and so nothing writes into a job after main returns).
void fs_join_all() {
  std::lock_guard<std::mutex> lock(g_fs_mu);
  for (size_t i = 0; i < g_fs_jobs.size(); i++) {
    if (g_fs_jobs[i]->worker.joinable()) g_fs_jobs[i]->worker.join();
  }
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
// job id. TS polls wv_fs_status() from its tick loop and drains the payload
// with wv_fs_byte() once the job is terminal. On failure the payload is the
// error message, so success and failure share one drain path.

int32_t wv_fs_read(int32_t h, const uint8_t *p, size_t n) {
  if (!app_at(h)) return -1;
  int32_t id = fs_new_job();
  FsJob *j = fs_job_at(id);
  if (!j) return -1;
  j->worker = std::thread(fs_read_worker, j, to_str(p, n));
  return id;
}

int32_t wv_fs_write(int32_t h, const uint8_t *p, size_t n, const uint8_t *dp,
                    size_t dn) {
  if (!app_at(h)) return -1;
  int32_t id = fs_new_job();
  FsJob *j = fs_job_at(id);
  if (!j) return -1;
  j->worker = std::thread(fs_write_worker, j, to_str(p, n), to_str(dp, dn));
  return id;
}

// 0 = still running, 1 = done, 2 = failed, -1 = no such job.
int32_t wv_fs_status(int32_t h, int32_t id) {
  if (!app_at(h)) return -1;
  FsJob *j = fs_job_at(id);
  if (!j) return -1;
  return j->status.load(std::memory_order_acquire);
}

// Hand a finished job's payload to TS in one call. The callback is
// lifetime:"call", so it runs synchronously here — on the UI thread, the only
// thread allowed to touch the scriptc runtime. The worker is already done by
// then (the caller has observed a terminal status), so `data` is stable.
int32_t wv_fs_take(int32_t h, int32_t id,
                   void (*sink)(const uint8_t *, size_t, void *), void *ctx) {
  if (!app_at(h)) return -1;
  FsJob *j = fs_job_at(id);
  if (!j || !sink) return -1;
  if (j->status.load(std::memory_order_acquire) == FS_PENDING) return -1;
  sink(reinterpret_cast<const uint8_t *>(j->data.data()), j->data.size(), ctx);
  return 0;
}

// Release the slot for reuse. Refuses while the worker is still running, so a
// job's buffer can never be recycled out from under its own thread.
int32_t wv_fs_free(int32_t h, int32_t id) {
  if (!app_at(h)) return -1;
  FsJob *j = fs_job_at(id);
  if (!j) return -1;
  if (j->status.load(std::memory_order_acquire) == FS_PENDING) return -1;
  std::lock_guard<std::mutex> lock(g_fs_mu);
  if (j->worker.joinable()) j->worker.join();
  j->data.clear();
  j->data.shrink_to_fit();
  j->used = false;
  return 0;
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
  fs_join_all();  // nor may an in-flight read outlive the app
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
