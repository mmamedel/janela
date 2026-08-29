// wvshim.cc — a C-ABI shim over webview.h shaped to scriptc's FFI format 2.
//
// Three constraints drive every design decision here:
//   1. scriptc has no pointer/u64 type, so webview_t can never cross the
//      boundary. We keep a handle table and hand out int32 indices.
//   2. Callback params/returns are numeric scalars only, so the request JSON
//      cannot be passed as a callback argument. We stage it in a shim-side
//      buffer and let TS drain it byte-at-a-time via re-entrant FFI calls.
//   3. Callbacks are lifetime:"call" only. webview_bind wants a retained
//      callback, which is not expressible. Instead the TS callback is handed
//      to wv_run(), which blocks for the whole app lifetime — so "call scope"
//      and "app lifetime" coincide, and bind dispatch happens inside it.

#include "webview.h"

#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

namespace {

struct Bind {
  std::string name;
};

struct App {
  webview_t w = nullptr;
  bool used = false;
  std::vector<Bind> binds;

  // Callback supplied by TS for the duration of wv_run().
  int32_t (*cb)(uint32_t, uint32_t, void *) = nullptr;
  void *cb_ctx = nullptr;

  // Staging for the in-flight request.
  std::string req;      // JSON args array from JS
  std::string cur_id;   // webview's call id, needed by webview_return
  std::string reply;    // response body assembled by TS
  uint32_t seq = 0;
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

// The single C trampoline registered with webview_bind for every binding.
// `arg` encodes the app index and bind index.
void trampoline(const char *id, const char *req, void *arg) {
  uintptr_t packed = reinterpret_cast<uintptr_t>(arg);
  App *a = &g_apps[packed >> 32];
  uint32_t bind_index = static_cast<uint32_t>(packed & 0xffffffffu);

  if (!a->cb) return;  // no TS handler installed

  a->req = req ? req : "";
  a->cur_id = id ? id : "";
  a->reply.clear();
  a->seq++;

  // Re-entrancy: this call lands back in TS, which will call wv_req_byte()
  // etc. back into this shim before returning.
  int32_t status = a->cb(bind_index, a->seq, a->cb_ctx);

  webview_return(a->w, a->cur_id.c_str(), status,
                 a->reply.empty() ? "null" : a->reply.c_str());
}

}  // namespace

extern "C" {

int32_t wv_create(int32_t debug) {
  for (int32_t i = 0; i < 8; i++) {
    if (g_apps[i].used) continue;
    webview_t w = webview_create(debug, nullptr);
    if (!w) return -1;
    g_apps[i] = App{};
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
  uint32_t idx = static_cast<uint32_t>(a->binds.size());
  a->binds.push_back(Bind{to_str(p, n)});
  uintptr_t packed = (static_cast<uintptr_t>(h) << 32) | idx;
  int rc = webview_bind(a->w, a->binds[idx].name.c_str(), trampoline,
                        reinterpret_cast<void *>(packed));
  if (rc != WEBVIEW_ERROR_OK) return -1;
  return static_cast<int32_t>(idx);
}

// ---- request payload, drained byte-at-a-time from inside the TS callback ----
int32_t wv_req_len(int32_t h) {
  App *a = app_at(h);
  if (!a) return -1;
  return static_cast<int32_t>(a->req.size());
}

int32_t wv_req_byte(int32_t h, int32_t i) {
  App *a = app_at(h);
  if (!a || i < 0 || static_cast<size_t>(i) >= a->req.size()) return -1;
  return static_cast<uint8_t>(a->req[i]);
}

// ---- reply payload, pushed byte-at-a-time from inside the TS callback ----
int32_t wv_reply_reset(int32_t h) {
  App *a = app_at(h);
  if (!a) return -1;
  a->reply.clear();
  return 0;
}

int32_t wv_reply_push(int32_t h, int32_t byte) {
  App *a = app_at(h);
  if (!a) return -1;
  a->reply.push_back(static_cast<char>(byte & 0xff));
  return 0;
}

// Blocks for the app's lifetime; dispatches bind calls into `cb`.
int32_t wv_run(int32_t h, int32_t (*cb)(uint32_t, uint32_t, void *),
               void *cb_ctx) {
  App *a = app_at(h);
  if (!a) return -1;
  a->cb = cb;
  a->cb_ctx = cb_ctx;
  int rc = webview_run(a->w);
  a->cb = nullptr;  // callback must not outlive the call, per lifetime:"call"
  a->cb_ctx = nullptr;
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
  webview_destroy(a->w);
  a->used = false;
  a->w = nullptr;
  return 0;
}

}  // extern "C"
