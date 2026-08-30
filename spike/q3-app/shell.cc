// SPIKE — the INVERTED shape: this native shell owns main() and the UI loop.
// TypeScript is a linked scriptc library it calls into. Compare janela today,
// where TS owns main and calls C through FFI.
#include "webview.h"

#include <cstdio>
#include <cstdint>
#include <cstring>
#include <string>

extern "C" {
void jl_init(void);
void jl_set_panic_sink(void (*fn)(void *, const char *, size_t, const char *, size_t), void *ctx);
void jl_reset(void);
void jl_handle_invoke(const char *cmd, size_t cmd_len, const char *args, size_t args_len,
                      char **out, size_t *out_len);
}

static void panic_sink(void *ctx, const char *sym, size_t symlen, const char *msg, size_t msglen) {
  (void)ctx;
  std::fprintf(stderr, "[panic] %.*s: %.*s\n", (int)symlen, sym, (int)msglen, msg);
}

int main() {
  jl_set_panic_sink(panic_sink, nullptr);
  jl_init();

  webview_t w = webview_create(0, nullptr);
  webview_set_title(w, "janela library-mode spike");
  webview_set_size(w, 640, 400, WEBVIEW_HINT_NONE);

  // One binding carries every command, exactly like janela's __invoke.
  webview_bind(
      w, "__invoke",
      [](const char *id, const char *req, void *arg) {
        webview_t wv = static_cast<webview_t>(arg);
        // req is ["cmd", "argsJson"] — pull the two strings out crudely (spike).
        std::string r(req ? req : "[]");
        size_t c0 = r.find('"'), c1 = r.find('"', c0 + 1);
        std::string cmd = r.substr(c0 + 1, c1 - c0 - 1);
        size_t a0 = r.find('"', c1 + 1), a1 = r.rfind('"');
        std::string args = r.substr(a0 + 1, a1 - a0 - 1);
        // Unescape the inner JSON string (spike-grade: only \" and \\).
        std::string unesc;
        for (size_t i = 0; i < args.size(); i++) {
          if (args[i] == '\\' && i + 1 < args.size()) { unesc.push_back(args[++i]); }
          else unesc.push_back(args[i]);
        }

        char *out = nullptr; size_t out_len = 0;
        jl_handle_invoke(cmd.data(), cmd.size(), unesc.data(), unesc.size(), &out, &out_len);
        std::string reply(out ? out : "null", out_len);
        std::printf("[shell] cmd=%s args=%s -> %s\n", cmd.c_str(), unesc.c_str(), reply.c_str());
        webview_return(wv, id, 0, reply.c_str());
        jl_reset();  // release the library's result arena after each call
      },
      w);

  webview_bind(
      w, "__quit",
      [](const char *id, const char *, void *arg) {
        webview_t wv = static_cast<webview_t>(arg);
        webview_return(wv, id, 0, "null");
        webview_terminate(wv);
      },
      w);

  webview_init(w,
      "window.janela = {"
      "  invoke: function (cmd, args) {"
      "    return window.__invoke(cmd, JSON.stringify(args === undefined ? null : args));"
      "  },"
      "  quit: function () { return window.__quit(); }"
      "};");

  webview_set_html(w,
      "<!doctype html><html><body><script>"
      "window.onload = async () => {"
      "  const sum = await janela.invoke('add', { a: 2, b: 40 });"
      "  const hi = await janela.invoke('greet', { name: 'inverted \\u2014 \\u00e7\\u00e3\\u00e9 \\ud83d\\ude80' });"
      "  const st = await janela.invoke('stats', {});"
      "  document.title = 'sum=' + sum;"
      "  await janela.invoke('log', { sum: sum, hi: hi, invokes: st.invokes });"
      "  await janela.quit();"
      "};"
      "</script></body></html>");

  int rc = webview_run(w);
  webview_destroy(w);
  std::printf("[shell] run returned %d\n", rc);
  return rc;
}
