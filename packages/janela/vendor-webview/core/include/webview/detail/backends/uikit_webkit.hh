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

#ifndef WEBVIEW_BACKENDS_UIKIT_WEBKIT_HH
#define WEBVIEW_BACKENDS_UIKIT_WEBKIT_HH

#if defined(__cplusplus) && !defined(WEBVIEW_HEADER)

#include "../../macros.h"

#if defined(WEBVIEW_PLATFORM_DARWIN) && defined(WEBVIEW_UIKIT)

//
// ====================================================================
//
// This implementation uses the UIKit WKWebView backend on iOS and its
// derivatives. Like the Cocoa backend it is written using the ObjC runtime
// rather than Objective-C, so the file compiles as plain C++. Pass
// "-framework UIKit -framework WebKit" to the linker.
//
// How this differs from the Cocoa backend, and why:
//
//   * UIApplicationMain() never returns. On macOS the Cocoa backend starts
//     and stops the run loop during construction so that it can create its
//     window before run() is called; that is not possible here. Instead the
//     web view is built eagerly in the constructor (a WKWebView does not need
//     a window to exist) and only the UIWindow and root view controller are
//     created when the application finishes launching. Everything that acts
//     on the web view — navigate, set_html, init scripts, bind — therefore
//     still works before run().
//
//   * An iOS application cannot exit itself; Apple's guidance is that the
//     system terminates apps. terminate() is accordingly a no-op.
//
//   * A phone has no window to title or resize: the window is the screen.
//     set_title() sets the root view controller's title, which is visible
//     only if an embedder puts it in a navigation stack, and set_size() is
//     a no-op. Both report success so that portable code does not have to
//     branch on the platform.
//
// ====================================================================
//

#include "../../types.hh"
#include "../engine_base.hh"
#include "../platform/darwin/cocoa/NSNotification.hh"
#include "../platform/darwin/cocoa/NSNumber.hh"
#include "../platform/darwin/cocoa/NSObject.hh"
#include "../platform/darwin/cocoa/NSRect.hh"
#include "../platform/darwin/cocoa/NSString.hh"
#include "../platform/darwin/cocoa/NSURL.hh"
#include "../platform/darwin/cocoa/NSURLRequest.hh"
#include "../platform/darwin/cocoa/NSValue.hh"
#include "../platform/darwin/objc/objc.hh"
#include "../platform/darwin/uikit/uikit.hh"
#include "../platform/darwin/webkit/webkit.hh"
#include "../user_script.hh"

#include <atomic>
#include <functional>
#include <list>
#include <memory>
#include <string>

#include <CoreFoundation/CoreFoundation.h>
#include <dispatch/dispatch.h>
// <objc/objc-runtime.h> is an umbrella that only exists in the macOS SDK;
// these two are present on every Apple platform.
#include <objc/message.h>
#include <objc/runtime.h>

namespace webview {
namespace detail {

class user_script::impl {
public:
  impl(id script) : m_script{objc::retain(script)} {}

  ~impl() { objc::release(m_script); }

  impl(const impl &) = delete;
  impl &operator=(const impl &) = delete;
  impl(impl &&) = delete;
  impl &operator=(impl &&) = delete;

  id get_native() const { return m_script; }

private:
  id m_script{};
};

// Encapsulate backend in its own namespace to avoid polluting the parent
// namespace when pulling in commonly-used symbols from other namespaces.
namespace uikit_webkit {

using namespace cocoa;
using namespace uikit;
using namespace webkit;

class uikit_wkwebview_engine : public engine_base {
public:
  /// @param window When null, the engine creates the UIWindow and root view
  ///        controller itself once the application finishes launching. When
  ///        non-null it is taken as a UIView the web view is added to, for
  ///        embedders that already own the application and its view hierarchy.
  uikit_wkwebview_engine(bool debug, void *window)
      : engine_base{!window}, m_host_view{static_cast<id>(window)} {
    webview_settings(debug);
    if (!owns_window()) {
      attach_to_host_view();
    }
  }

  uikit_wkwebview_engine(const uikit_wkwebview_engine &) = delete;
  uikit_wkwebview_engine &operator=(const uikit_wkwebview_engine &) = delete;
  uikit_wkwebview_engine(uikit_wkwebview_engine &&) = delete;
  uikit_wkwebview_engine &operator=(uikit_wkwebview_engine &&) = delete;

  virtual ~uikit_wkwebview_engine() {
    objc::autoreleasepool arp;
    if (m_webview) {
      objc::release(m_webview);
      m_webview = nullptr;
    }
    if (m_controller) {
      objc::release(m_controller);
      m_controller = nullptr;
    }
    if (m_window) {
      objc::release(m_window);
      m_window = nullptr;
    }
    if (m_app_delegate) {
      objc::release(m_app_delegate);
      m_app_delegate = nullptr;
    }
  }

protected:
  result<void *> window_impl() override {
    if (m_window) {
      return m_window;
    }
    // Before the application has finished launching there is no window yet.
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

  /// An iOS application cannot terminate itself in a way Apple supports, so
  /// this does nothing. It reports success rather than an error so that code
  /// written against the desktop backends keeps working unchanged.
  noresult terminate_impl() override { return {}; }

  /// Enters UIApplicationMain, which does not return. Anything an embedder
  /// wants to happen must therefore be arranged before calling run(), or from
  /// a dispatched callback afterwards.
  noresult run_impl() override {
    objc::autoreleasepool arp;
    if (!owns_window()) {
      // The embedder owns the application and is running its own loop.
      return {};
    }
    m_app_delegate = create_app_delegate();
    set_associated_webview(m_app_delegate, this);
    UIApplication_main(nullptr,
                       NSString_stringWithUTF8String(app_delegate_class_name));
    return {};
  }

  noresult dispatch_impl(std::function<void()> f) override {
    dispatch_async_f(dispatch_get_main_queue(), new dispatch_fn_t(f),
                     (dispatch_function_t)([](void *arg) {
                       auto f = static_cast<dispatch_fn_t *>(arg);
                       (*f)();
                       delete f;
                     }));
    return {};
  }

  /// A phone has no window chrome to put a title in. The title is set on the
  /// root view controller, where it is visible only if the embedder places
  /// that controller inside a navigation stack.
  noresult set_title_impl(const std::string &title) override {
    objc::autoreleasepool arp;
    if (m_controller) {
      UIViewController_set_title(m_controller, title);
    }
    m_title = title;
    return {};
  }

  /// The window is the screen: an app does not choose its size. Accepted and
  /// ignored so that portable code does not have to branch on the platform.
  noresult set_size_impl(int /*width*/, int /*height*/,
                         webview_hint_t /*hints*/) override {
    return {};
  }

  noresult navigate_impl(const std::string &url) override {
    objc::autoreleasepool arp;
    WKWebView_loadRequest(
        m_webview, NSURLRequest_requestWithURL(NSURL_URLWithString(url)));
    return {};
  }

  noresult set_html_impl(const std::string &html) override {
    objc::autoreleasepool arp;
    WKWebView_loadHTMLString(m_webview, NSString_stringWithUTF8String(html),
                             nullptr);
    return {};
  }

  noresult eval_impl(const std::string &js) override {
    objc::autoreleasepool arp;
    // URL is null before content has begun loading.
    auto nsurl{WKWebView_get_URL(m_webview)};
    if (!nsurl) {
      return {};
    }
    WKWebView_evaluateJavaScript(m_webview, NSString_stringWithUTF8String(js),
                                 nullptr);
    return {};
  }

  user_script add_user_script_impl(const std::string &js) override {
    objc::autoreleasepool arp;
    auto wk_script{WKUserScript_withSource(
        NSString_stringWithUTF8String(js),
        WKUserScriptInjectionTimeAtDocumentStart, true)};
    // Script is retained when added.
    WKUserContentController_addUserScript(m_manager, wk_script);
    user_script script{
        js, user_script::impl_ptr{new user_script::impl{wk_script},
                                  [](user_script::impl *p) { delete p; }}};
    return script;
  }

  void remove_all_user_scripts_impl(
      const std::list<user_script> & /*scripts*/) override {
    objc::autoreleasepool arp;
    WKUserContentController_removeAllUserScripts(m_manager);
  }

  bool are_user_scripts_equal_impl(const user_script &first,
                                   const user_script &second) override {
    auto *wk_first = first.get_impl().get_native();
    auto *wk_second = second.get_impl().get_native();
    return wk_first == wk_second;
  }

  /// UIKit has no equivalent of pulling one event off the queue, so the run
  /// loop is spun for a short interval instead. This is only used to deplete
  /// already-queued work; it is not the application's main loop.
  void run_event_loop_while(std::function<bool()> fn) override {
    objc::autoreleasepool arp;
    while (fn()) {
      objc::autoreleasepool arp2;
      CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.01, true);
    }
  }

private:
  static constexpr auto app_delegate_class_name = "WebviewUIApplicationDelegate";

  id create_app_delegate() {
    objc::autoreleasepool arp;
    // Avoid crash due to registering same class twice
    auto cls = objc_lookUpClass(app_delegate_class_name);
    if (!cls) {
      cls = objc_allocateClassPair(objc::get_class("UIResponder"),
                                   app_delegate_class_name, 0);
      class_addProtocol(cls, objc_getProtocol("UIApplicationDelegate"));
      class_addMethod(
          cls, objc::selector("application:didFinishLaunchingWithOptions:"),
          (IMP)(+[](id self, SEL, id, id) -> BOOL {
            auto w = get_associated_webview(self);
            if (w) {
              w->on_application_did_finish_launching();
            }
            return YES;
          }),
          "c@:@@");
      // UIKit instantiates the delegate class itself, so the instance it
      // creates must be able to find the engine. The association is placed on
      // the class, and looked up through it when the instance is called.
      objc_registerClassPair(cls);
    }
    return objc::Class_new(cls);
  }

  static uikit_wkwebview_engine *get_associated_webview(id object) {
    objc::autoreleasepool arp;
    // The delegate UIKit creates is not the instance we made, so the engine is
    // associated with the class object, which both share.
    id cls = reinterpret_cast<id>(object_getClass(object));
    if (id assoc_obj{objc_getAssociatedObject(cls, "webview")}) {
      uikit_wkwebview_engine *w{};
      NSValue_getValue(assoc_obj, &w, sizeof(w));
      return w;
    }
    return nullptr;
  }

  static void set_associated_webview(id object, uikit_wkwebview_engine *w) {
    objc::autoreleasepool arp;
    id cls = reinterpret_cast<id>(object_getClass(object));
    objc_setAssociatedObject(cls, "webview", NSValue_valueWithPointer(w),
                             OBJC_ASSOCIATION_RETAIN);
  }

  id create_script_message_handler() {
    objc::autoreleasepool arp;
    constexpr auto class_name = "WebviewWKScriptMessageHandler";
    // Avoid crash due to registering same class twice
    auto cls = objc_lookUpClass(class_name);
    if (!cls) {
      cls = objc_allocateClassPair(objc::get_class("NSObject"), class_name, 0);
      class_addProtocol(cls, objc_getProtocol("WKScriptMessageHandler"));
      class_addMethod(
          cls, objc::selector("userContentController:didReceiveScriptMessage:"),
          (IMP)(+[](id self, SEL, id, id msg) {
            auto w = get_associated_webview(self);
            if (w) {
              w->on_message(
                  NSString_get_UTF8String(WKScriptMessage_get_body(msg)));
            }
          }),
          "v@:@@");
      objc_registerClassPair(cls);
    }
    auto instance{objc::Class_new(cls)};
    set_associated_webview(instance, this);
    return instance;
  }

  /// Builds the web view. A WKWebView does not need a window, so everything
  /// except the window itself can be set up before the application launches.
  void webview_settings(bool debug) {
    objc::autoreleasepool arp;

    auto config{objc::autorelease(WKWebViewConfiguration_new())};
    m_manager = WKWebViewConfiguration_get_userContentController(config);

    auto preferences = WKWebViewConfiguration_get_preferences(config);
    auto yes_value = NSNumber_numberWithBool(true);
    if (debug) {
      NSObject_setValue_forKey(
          preferences, yes_value,
          NSString_stringWithUTF8String("developerExtrasEnabled"));
    }

    m_webview =
        objc::retain(WKWebView_withFrame(NSRectMake(0, 0, 0, 0), config));
    if (debug) {
      // Inspectable via Safari on OS versions that disable it by default.
      WKWebView_set_inspectable(m_webview, true);
    }

    auto script_message_handler =
        objc::autorelease(create_script_message_handler());
    WKUserContentController_addScriptMessageHandler(
        m_manager, script_message_handler,
        NSString_stringWithUTF8String("__webview__"));

    add_init_script("function(message) {\n\
  return window.webkit.messageHandlers.__webview__.postMessage(message);\n\
}");
  }

  /// Embedder-owned case: the caller handed us a UIView to live in.
  void attach_to_host_view() {
    objc::autoreleasepool arp;
    UIView_set_frame(m_webview, UIView_get_bounds(m_host_view));
    UIView_set_autoresizingMask(
        m_webview, static_cast<UIViewAutoresizing>(
                       UIViewAutoresizingFlexibleWidth |
                       UIViewAutoresizingFlexibleHeight));
    UIView_addSubview(m_host_view, m_webview);
    on_window_created();
  }

  /// Engine-owned case: build the window and root view controller now that
  /// UIKit is running, and put the already-built web view inside it.
  void on_application_did_finish_launching() {
    objc::autoreleasepool arp;

    m_window = objc::retain(
        UIWindow_withFrame(UIScreen_get_bounds(UIScreen_get_mainScreen())));
    m_controller = objc::retain(UIViewController_new());
    if (!m_title.empty()) {
      UIViewController_set_title(m_controller, m_title);
    }
    UIWindow_set_rootViewController(m_window, m_controller);

    auto root_view = UIViewController_get_view(m_controller);
    UIView_set_frame(m_webview, UIView_get_bounds(root_view));
    UIView_set_autoresizingMask(
        m_webview, static_cast<UIViewAutoresizing>(
                       UIViewAutoresizingFlexibleWidth |
                       UIViewAutoresizingFlexibleHeight));
    UIView_addSubview(root_view, m_webview);

    UIWindow_makeKeyAndVisible(m_window);
    on_window_created();
  }

  id m_app_delegate{};
  id m_window{};
  id m_controller{};
  id m_host_view{};
  id m_webview{};
  id m_manager{};
  std::string m_title;
};

} // namespace uikit_webkit
} // namespace detail

using browser_engine = detail::uikit_webkit::uikit_wkwebview_engine;

} // namespace webview

#endif // defined(WEBVIEW_PLATFORM_DARWIN) && defined(WEBVIEW_UIKIT)
#endif // defined(__cplusplus) && !defined(WEBVIEW_HEADER)
#endif // WEBVIEW_BACKENDS_UIKIT_WEBKIT_HH
