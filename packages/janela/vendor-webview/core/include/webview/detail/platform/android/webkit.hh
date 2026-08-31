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

#ifndef WEBVIEW_PLATFORM_ANDROID_WEBKIT_HH
#define WEBVIEW_PLATFORM_ANDROID_WEBKIT_HH

#if defined(__cplusplus) && !defined(WEBVIEW_HEADER)

#include "../../../macros.h"

#if defined(WEBVIEW_PLATFORM_ANDROID)

#include "jni.hh"

#include <string>

namespace webview {
namespace detail {
namespace android {

/// Thin typed wrappers over the android.webkit classes. Each takes the JNIEnv
/// of the calling thread; every one of these must be called on the UI thread,
/// which android.webkit.WebView requires of all its methods.
namespace webkit {

/// android.webkit.WebView#loadUrl(String)
inline void WebView_loadUrl(JNIEnv *env, jobject webview,
                            const std::string &url) {
  jclass cls = env->GetObjectClass(webview);
  jmethodID mid = env->GetMethodID(cls, "loadUrl", "(Ljava/lang/String;)V");
  local_ref jurl{env, to_jstring(env, url)};
  env->CallVoidMethod(webview, mid, static_cast<jstring>(jurl.get()));
  clear_exception(env);
  env->DeleteLocalRef(cls);
}

/// android.webkit.WebView#loadDataWithBaseURL(String, String, String, String,
/// String). A base URL is supplied so that the document has an origin; with a
/// null base the page is opaque and browser storage APIs refuse to work.
inline void WebView_loadDataWithBaseURL(JNIEnv *env, jobject webview,
                                        const std::string &base_url,
                                        const std::string &html) {
  jclass cls = env->GetObjectClass(webview);
  jmethodID mid = env->GetMethodID(cls, "loadDataWithBaseURL",
                                   "(Ljava/lang/String;Ljava/lang/String;Ljava/"
                                   "lang/String;Ljava/lang/String;Ljava/lang/"
                                   "String;)V");
  local_ref jbase{env, to_jstring(env, base_url)};
  local_ref jhtml{env, to_jstring(env, html)};
  local_ref jmime{env, to_jstring(env, "text/html")};
  local_ref jenc{env, to_jstring(env, "UTF-8")};
  env->CallVoidMethod(webview, mid, static_cast<jstring>(jbase.get()),
                      static_cast<jstring>(jhtml.get()),
                      static_cast<jstring>(jmime.get()),
                      static_cast<jstring>(jenc.get()), nullptr);
  clear_exception(env);
  env->DeleteLocalRef(cls);
}

/// android.webkit.WebView#evaluateJavascript(String, ValueCallback). The
/// callback is null: nothing here needs the result, and a non-null one would
/// require a Java class to receive it.
inline void WebView_evaluateJavascript(JNIEnv *env, jobject webview,
                                       const std::string &js) {
  jclass cls = env->GetObjectClass(webview);
  jmethodID mid = env->GetMethodID(
      cls, "evaluateJavascript",
      "(Ljava/lang/String;Landroid/webkit/ValueCallback;)V");
  local_ref jjs{env, to_jstring(env, js)};
  env->CallVoidMethod(webview, mid, static_cast<jstring>(jjs.get()), nullptr);
  clear_exception(env);
  env->DeleteLocalRef(cls);
}

/// android.webkit.WebView#getUrl(), used to tell whether a document exists yet.
inline std::string WebView_getUrl(JNIEnv *env, jobject webview) {
  jclass cls = env->GetObjectClass(webview);
  jmethodID mid = env->GetMethodID(cls, "getUrl", "()Ljava/lang/String;");
  auto result = static_cast<jstring>(env->CallObjectMethod(webview, mid));
  clear_exception(env);
  env->DeleteLocalRef(cls);
  if (!result) {
    return {};
  }
  local_ref owned{env, result};
  return to_string(env, result);
}

} // namespace webkit
} // namespace android
} // namespace detail
} // namespace webview

#endif // defined(WEBVIEW_PLATFORM_ANDROID)
#endif // defined(__cplusplus) && !defined(WEBVIEW_HEADER)
#endif // WEBVIEW_PLATFORM_ANDROID_WEBKIT_HH
