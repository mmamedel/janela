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

#ifndef WEBVIEW_PLATFORM_DARWIN_UIKIT_UIVIEW_HH
#define WEBVIEW_PLATFORM_DARWIN_UIKIT_UIVIEW_HH

#if defined(__cplusplus) && !defined(WEBVIEW_HEADER)

#include "../../../../macros.h"

#if defined(WEBVIEW_PLATFORM_DARWIN) && defined(WEBVIEW_UIKIT)

#include "../cocoa/NSRect.hh"
#include "../objc/objc.hh"

namespace webview {
namespace detail {
namespace uikit {

/// Mirrors UIViewAutoresizing. A web view added as a subview of the root
/// view controller's view must track it on both axes, or it keeps the size it
/// was created with when the device rotates.
enum UIViewAutoresizing : NSUInteger {
  UIViewAutoresizingNone = 0,
  UIViewAutoresizingFlexibleWidth = 1 << 1,
  UIViewAutoresizingFlexibleHeight = 1 << 4
};

inline id UIView_withFrame(cocoa::NSRect frame) {
  return objc::msg_send<id>(
      objc::msg_send<id>(objc::get_class("UIView"), objc::selector("alloc")),
      objc::selector("initWithFrame:"), frame);
}

inline void UIView_addSubview(id self, id subview) {
  objc::msg_send<void>(self, objc::selector("addSubview:"), subview);
}

inline cocoa::NSRect UIView_get_bounds(id self) {
  return objc::msg_send_stret<cocoa::NSRect>(self, objc::selector("bounds"));
}

inline void UIView_set_frame(id self, cocoa::NSRect frame) {
  objc::msg_send<void>(self, objc::selector("setFrame:"), frame);
}

inline void UIView_set_autoresizingMask(id self, UIViewAutoresizing mask) {
  objc::msg_send<void>(self, objc::selector("setAutoresizingMask:"), mask);
}

} // namespace uikit
} // namespace detail
} // namespace webview

#endif // defined(WEBVIEW_PLATFORM_DARWIN) && defined(WEBVIEW_UIKIT)
#endif // defined(__cplusplus) && !defined(WEBVIEW_HEADER)
#endif // WEBVIEW_PLATFORM_DARWIN_UIKIT_UIVIEW_HH
