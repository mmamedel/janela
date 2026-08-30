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

#ifndef WEBVIEW_PLATFORM_DARWIN_UIKIT_UIAPPLICATION_HH
#define WEBVIEW_PLATFORM_DARWIN_UIKIT_UIAPPLICATION_HH

#if defined(__cplusplus) && !defined(WEBVIEW_HEADER)

#include "../../../../macros.h"

#if defined(WEBVIEW_PLATFORM_DARWIN) && defined(WEBVIEW_UIKIT)

#include "../objc/objc.hh"

#include <crt_externs.h>

extern "C" {
/// Declared here rather than by including <UIKit/UIKit.h> so that this header
/// stays compilable as plain C++ — the rest of the backend drives UIKit
/// through the Objective-C runtime, and pulling in the framework headers
/// would require Objective-C++.
int UIApplicationMain(int argc, char *argv[], id principal_class_name,
                      id delegate_class_name);
}

namespace webview {
namespace detail {
namespace uikit {

/// Runs the application's main loop.
///
/// This does not return. UIKit owns the process from here until the system
/// terminates the app; there is no supported way for an iOS app to exit
/// itself, which is why the backend's terminate is a no-op.
///
/// argc/argv are read from the process rather than threaded through the
/// public API, so that an embedder does not have to hand them to the engine.
inline int UIApplication_main(id principal_class_name, id delegate_class_name) {
  return UIApplicationMain(*_NSGetArgc(), *_NSGetArgv(), principal_class_name,
                           delegate_class_name);
}

inline id UIApplication_get_sharedApplication() {
  return objc::msg_send<id>(objc::get_class("UIApplication"),
                            objc::selector("sharedApplication"));
}

inline id UIApplication_get_delegate(id self) {
  return objc::msg_send<id>(self, objc::selector("delegate"));
}

} // namespace uikit
} // namespace detail
} // namespace webview

#endif // defined(WEBVIEW_PLATFORM_DARWIN) && defined(WEBVIEW_UIKIT)
#endif // defined(__cplusplus) && !defined(WEBVIEW_HEADER)
#endif // WEBVIEW_PLATFORM_DARWIN_UIKIT_UIAPPLICATION_HH
