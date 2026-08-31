/*
 * MIT License
 *
 * Copyright (c) 2017 Serge Zaitsev
 * Copyright (c) 2022 Steffen André Langnes
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

#ifndef WEBVIEW_BACKENDS_ANDROID_WEBKIT_HH
#define WEBVIEW_BACKENDS_ANDROID_WEBKIT_HH

#if defined(__cplusplus) && !defined(WEBVIEW_HEADER)

#include "../../macros.h"

#if defined(WEBVIEW_PLATFORM_ANDROID)

//
// ====================================================================
//
// This implementation drives android.webkit.WebView over JNI.
//
// UNLIKE EVERY OTHER BACKEND IN THIS LIBRARY, IT IS NOT SELF-SUFFICIENT.
// A small companion Java class must be compiled into the APK. That is not a
// shortcut: android.webkit.WebView is a Java API with no C surface, every
// framework callback an embedder needs (a message from the page, a page-start
// notification, a Runnable posted to the UI thread) arrives as a virtual Java
// method, and native code cannot define a Java class to receive one —
// ART's JNI DefineClass is unimplemented, and the framework classes involved
// are abstract rather than interfaces, so java.lang.reflect.Proxy does not
// help either. The reference implementation in this space (wry, Apache-2.0)
// reaches the same conclusion and ships eight Kotlin files; the class this
// backend asks for is one file of about eighty lines.
//
// The class is located by name, so an embedder may relocate it:
//
//     #define WEBVIEW_ANDROID_BRIDGE_CLASS "dev/webview/WebviewBridge"
//
// Its native methods are wired with RegisterNatives rather than by symbol
// name, which is what lets the name be configurable at all.
//
// Required Java shape (see docs; JNI signatures are asserted at attach time):
//
//     public static void   post(long token)
//     public static Object createWebView(Activity a, boolean debug)
//     public static void   setContentView(Activity a, Object webView)
//     public static void   addToView(Object parent, Object webView)
//     public static void   finishActivity(Activity a)
//     public static void   setTitle(Activity a, String title)
//     private static native void nativePost(long token)
//     private static native void nativeOnMessage(String message)
//     private static native void nativeOnPageStarted()
//
// How this differs from the desktop backends, and why:
//
//   * The platform already owns the loop. An Android application is alive
//     before any of this runs — the system created the Activity and its
//     Looper. run() therefore returns immediately rather than blocking: there
//     is no loop here to enter. An embedder's "main" is the Activity
//     lifecycle, not a call to run().
//
//   * terminate() calls Activity#finish(). An Android app may legitimately
//     close its own Activity, unlike iOS, though the process may outlive it.
//
//   * set_size() is a no-op: the window is the screen. set_title() sets the
//     Activity's label, which shows in the task switcher. Both report success
//     so that portable code need not branch on the platform.
//
//   * There is no document-start user script API in the framework
//     (WKUserScript has no android.webkit equivalent, and the androidx
//     WebViewCompat one is an optional dependency). User scripts are
//     therefore replayed from the page-started callback, which is marginally
//     later than document start.
//
//   * Every android.webkit.WebView method must run on the UI thread, and
//     native code usually is not on it. Calls are posted rather than made
//     directly, which makes navigate/set_html/eval asynchronous here.
//
// ====================================================================
//

#include "../../types.hh"
#include "../engine_base.hh"
#include "../platform/android/jni.hh"
#include "../platform/android/webkit.hh"
#include "../user_script.hh"

#include <chrono>
#include <cstdint>
#include <functional>
#include <list>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#if !defined(WEBVIEW_ANDROID_BRIDGE_CLASS)
#define WEBVIEW_ANDROID_BRIDGE_CLASS "dev/webview/WebviewBridge"
#endif

namespace webview {
namespace detail {

class user_script::impl {
public:
  impl(std::string source) : m_source{std::move(source)} {}

  impl(const impl &) = delete;
  impl &operator=(const impl &) = delete;
  impl(impl &&) = delete;
  impl &operator=(impl &&) = delete;

  const std::string &get_source() const { return m_source; }

private:
  std::string m_source;
};

// Encapsulate backend in its own namespace to avoid polluting the parent
// namespace when pulling in commonly-used symbols from other namespaces.
namespace android_webkit {

using namespace webview::detail::android;

class android_webkit_engine;

/// The one engine the JNI callbacks belong to. The Java bridge's native
/// methods are static — they carry no instance — so the engine is found here.
inline android_webkit_engine *&engine_ref() noexcept {
  static android_webkit_engine *engine{};
  return engine;
}

/// Work posted to the UI thread, keyed by the token handed to Java. Guarded
/// because dispatch() is called from arbitrary threads while the drain runs
/// on the UI thread.
inline std::mutex &posted_mutex() noexcept {
  static std::mutex m;
  return m;
}

inline std::map<std::int64_t, std::function<void()>> &posted_work() noexcept {
  static std::map<std::int64_t, std::function<void()>> work;
  return work;
}

class android_webkit_engine : public engine_base {
public:
  /// @param window When null, the engine creates a WebView and installs it as
  ///        the Activity's content view. When non-null it is taken as a global
  ///        reference to an android.view.ViewGroup the web view is added to,
  ///        for embedders that already own their view hierarchy.
  android_webkit_engine(bool debug, void *window)
      : engine_base{!window}, m_host_view{static_cast<jobject>(window)},
        m_debug{debug} {
    scoped_env env;
    if (!env) {
      return; // attach() was never called; every method degrades to a no-op
    }
    engine_ref() = this;
    create_webview(env.get());
    // The page reaches native through the @JavascriptInterface object the
    // Java bridge adds to the web view under this name.
    add_init_script("function(message) {\n\
  return window.__webview__host.postMessage(message);\n\
}");
  }

  android_webkit_engine(const android_webkit_engine &) = delete;
  android_webkit_engine &operator=(const android_webkit_engine &) = delete;
  android_webkit_engine(android_webkit_engine &&) = delete;
  android_webkit_engine &operator=(android_webkit_engine &&) = delete;

  virtual ~android_webkit_engine() {
    scoped_env env;
    if (env && m_webview) {
      env->DeleteGlobalRef(m_webview);
    }
    m_webview = nullptr;
    if (engine_ref() == this) {
      engine_ref() = nullptr;
    }
  }

  /// Called from the Java bridge when the page reports a message.
  void on_bridge_message(const std::string &msg) { on_message(msg); }

  /// Called from the Java bridge when a document starts loading. The
  /// framework has no document-start script API, so they are replayed here.
  void on_bridge_page_started() {
    std::vector<std::string> scripts;
    {
      std::lock_guard<std::mutex> lock{m_scripts_mutex};
      scripts = m_user_scripts;
    }
    scoped_env env;
    if (!env || !m_webview) {
      return;
    }
    for (const auto &js : scripts) {
      webkit::WebView_evaluateJavascript(env.get(), m_webview, js);
    }
  }

protected:
  result<void *> window_impl() override {
    if (activity_ref()) {
      return activity_ref();
    }
    return error_info{WEBVIEW_ERROR_INVALID_STATE};
  }

  result<void *> widget_impl() override {
    if (m_webview) {
      return m_webview;
    }
    return error_info{WEBVIEW_ERROR_INVALID_STATE};
  }

  result<void *> browser_controller_impl() override {
    if (m_webview) {
      return m_webview;
    }
    return error_info{WEBVIEW_ERROR_INVALID_STATE};
  }

  /// Closes the Activity. The process may outlive it — Android decides when a
  /// process ends — so this is not the same as exiting.
  noresult terminate_impl() override {
    call_bridge_activity("finishActivity");
    return {};
  }

  /// Returns immediately. The system created the Activity and its Looper
  /// before any of this ran, so there is no loop to enter; an embedder's
  /// lifetime is the Activity's, not this call's.
  noresult run_impl() override { return {}; }

  noresult dispatch_impl(std::function<void()> f) override {
    auto token = m_next_token++;
    {
      std::lock_guard<std::mutex> lock{posted_mutex()};
      posted_work().emplace(token, std::move(f));
    }
    scoped_env env;
    if (!env) {
      return {};
    }
    jclass cls = bridge_class(env.get());
    if (!cls) {
      return {};
    }
    jmethodID mid = env->GetStaticMethodID(cls, "post", "(J)V");
    if (mid) {
      env->CallStaticVoidMethod(cls, mid, static_cast<jlong>(token));
      clear_exception(env.get());
    }
    return {};
  }

  /// Sets the Activity label, which appears in the task switcher rather than
  /// on the window: a phone has no title bar.
  noresult set_title_impl(const std::string &title) override {
    scoped_env env;
    if (!env) {
      return {};
    }
    jclass cls = bridge_class(env.get());
    if (!cls) {
      return {};
    }
    jmethodID mid = env->GetStaticMethodID(
        cls, "setTitle", "(Landroid/app/Activity;Ljava/lang/String;)V");
    if (mid) {
      local_ref jtitle{env.get(), to_jstring(env.get(), title)};
      env->CallStaticVoidMethod(cls, mid, activity_ref(),
                                static_cast<jstring>(jtitle.get()));
      clear_exception(env.get());
    }
    return {};
  }

  /// The window is the screen: an app does not choose its size. Accepted and
  /// ignored so that portable code does not have to branch on the platform.
  noresult set_size_impl(int /*width*/, int /*height*/,
                         webview_hint_t /*hints*/) override {
    return {};
  }

  noresult navigate_impl(const std::string &url) override {
    on_ui_thread([this, url] {
      scoped_env env;
      if (env && m_webview) {
        webkit::WebView_loadUrl(env.get(), m_webview, url);
      }
    });
    return {};
  }

  noresult set_html_impl(const std::string &html) override {
    on_ui_thread([this, html] {
      scoped_env env;
      if (env && m_webview) {
        // A real base URL gives the document an origin; with a null base it is
        // opaque and the storage APIs a page may expect refuse to work.
        webkit::WebView_loadDataWithBaseURL(env.get(), m_webview,
                                            "https://webview.localhost/", html);
      }
    });
    return {};
  }

  noresult eval_impl(const std::string &js) override {
    on_ui_thread([this, js] {
      scoped_env env;
      if (env && m_webview) {
        webkit::WebView_evaluateJavascript(env.get(), m_webview, js);
      }
    });
    return {};
  }

  user_script add_user_script_impl(const std::string &js) override {
    {
      std::lock_guard<std::mutex> lock{m_scripts_mutex};
      m_user_scripts.push_back(js);
    }
    return user_script{js, user_script::impl_ptr{
                               new user_script::impl{js},
                               [](user_script::impl *p) { delete p; }}};
  }

  void remove_all_user_scripts_impl(
      const std::list<user_script> & /*scripts*/) override {
    std::lock_guard<std::mutex> lock{m_scripts_mutex};
    m_user_scripts.clear();
  }

  bool are_user_scripts_equal_impl(const user_script &first,
                                   const user_script &second) override {
    return first.get_impl().get_source() == second.get_impl().get_source();
  }

  /// The UI thread's Looper cannot be pumped from native code, and this is
  /// generally called from a thread that is not it, so the queue is polled
  /// instead of driven.
  void run_event_loop_while(std::function<bool()> fn) override {
    while (fn()) {
      std::this_thread::sleep_for(std::chrono::milliseconds(4));
    }
  }

private:
  /// Posts work to the UI thread unconditionally. Even when the caller is
  /// already on it, going through the queue keeps ordering predictable and
  /// guarantees no framework call happens beneath a foreign stack frame.
  void on_ui_thread(std::function<void()> f) { dispatch_impl(std::move(f)); }

  static jclass bridge_class(JNIEnv *env) {
    static jclass cached{};
    if (cached) {
      return cached;
    }
    jclass local = env->FindClass(WEBVIEW_ANDROID_BRIDGE_CLASS);
    if (!local || clear_exception(env)) {
      return nullptr;
    }
    cached = static_cast<jclass>(env->NewGlobalRef(local));
    env->DeleteLocalRef(local);
    return cached;
  }

  void call_bridge_activity(const char *name) {
    scoped_env env;
    if (!env) {
      return;
    }
    jclass cls = bridge_class(env.get());
    if (!cls) {
      return;
    }
    jmethodID mid =
        env->GetStaticMethodID(cls, name, "(Landroid/app/Activity;)V");
    if (mid) {
      env->CallStaticVoidMethod(cls, mid, activity_ref());
      clear_exception(env.get());
    }
  }

  void create_webview(JNIEnv *env) {
    jclass cls = bridge_class(env);
    if (!cls) {
      return;
    }
    jmethodID mid = env->GetStaticMethodID(
        cls, "createWebView",
        "(Landroid/app/Activity;Z)Landroid/webkit/WebView;");
    if (!mid) {
      clear_exception(env);
      return;
    }
    jobject local = env->CallStaticObjectMethod(
        cls, mid, activity_ref(), static_cast<jboolean>(m_debug));
    if (!local || clear_exception(env)) {
      return;
    }
    // Global: the web view outlives the call that produced it.
    m_webview = env->NewGlobalRef(local);
    env->DeleteLocalRef(local);

    if (owns_window()) {
      jmethodID set = env->GetStaticMethodID(
          cls, "setContentView",
          "(Landroid/app/Activity;Landroid/webkit/WebView;)V");
      if (set) {
        env->CallStaticVoidMethod(cls, set, activity_ref(), m_webview);
        clear_exception(env);
      }
      on_window_created();
    } else {
      jmethodID add = env->GetStaticMethodID(
          cls, "addToView",
          "(Landroid/view/View;Landroid/webkit/WebView;)V");
      if (add) {
        env->CallStaticVoidMethod(cls, add, m_host_view, m_webview);
        clear_exception(env);
      }
    }
  }

  jobject m_host_view{};
  jobject m_webview{};
  bool m_debug{};
  std::int64_t m_next_token{1};
  std::mutex m_scripts_mutex;
  std::vector<std::string> m_user_scripts;
};

// ---- the Java bridge's native methods --------------------------------------
//
// Registered by name at attach() time rather than exported with mangled
// symbols, so that WEBVIEW_ANDROID_BRIDGE_CLASS can be relocated.

inline void JNICALL native_post(JNIEnv * /*env*/, jclass /*cls*/,
                                jlong token) {
  std::function<void()> f;
  {
    std::lock_guard<std::mutex> lock{posted_mutex()};
    auto it = posted_work().find(static_cast<std::int64_t>(token));
    if (it == posted_work().end()) {
      return;
    }
    f = std::move(it->second);
    posted_work().erase(it);
  }
  if (f) {
    f();
  }
}

inline void JNICALL native_on_message(JNIEnv *env, jclass /*cls*/,
                                      jstring message) {
  auto *engine = engine_ref();
  if (!engine) {
    return;
  }
  engine->on_bridge_message(to_string(env, message));
}

inline void JNICALL native_on_page_started(JNIEnv * /*env*/, jclass /*cls*/) {
  if (auto *engine = engine_ref()) {
    engine->on_bridge_page_started();
  }
}

} // namespace android_webkit
} // namespace detail

namespace android {

/// Publishes the VM and the Activity, and wires the Java bridge's native
/// methods. An embedder calls this from JNI_OnLoad or from the Activity's
/// first native call, before constructing a webview.
///
/// @return true when the bridge class was found and its natives registered.
inline bool attach(JavaVM *vm, JNIEnv *env, jobject activity) {
  using namespace webview::detail::android;
  using namespace webview::detail::android_webkit;
  vm_ref() = vm;
  if (activity) {
    // Global: the Activity outlives the call that handed it to us.
    activity_ref() = env->NewGlobalRef(activity);
  }
  jclass cls = env->FindClass(WEBVIEW_ANDROID_BRIDGE_CLASS);
  if (!cls || clear_exception(env)) {
    return false;
  }
  const JNINativeMethod methods[] = {
      {const_cast<char *>("nativePost"), const_cast<char *>("(J)V"),
       reinterpret_cast<void *>(&native_post)},
      {const_cast<char *>("nativeOnMessage"),
       const_cast<char *>("(Ljava/lang/String;)V"),
       reinterpret_cast<void *>(&native_on_message)},
      {const_cast<char *>("nativeOnPageStarted"), const_cast<char *>("()V"),
       reinterpret_cast<void *>(&native_on_page_started)},
  };
  bool ok = env->RegisterNatives(cls, methods,
                                 sizeof(methods) / sizeof(methods[0])) == 0;
  clear_exception(env);
  env->DeleteLocalRef(cls);
  return ok;
}

} // namespace android

using browser_engine = detail::android_webkit::android_webkit_engine;

} // namespace webview

#endif // defined(WEBVIEW_PLATFORM_ANDROID)
#endif // defined(__cplusplus) && !defined(WEBVIEW_HEADER)
#endif // WEBVIEW_BACKENDS_ANDROID_WEBKIT_HH
