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

#ifndef WEBVIEW_PLATFORM_ANDROID_JNI_HH
#define WEBVIEW_PLATFORM_ANDROID_JNI_HH

#if defined(__cplusplus) && !defined(WEBVIEW_HEADER)

#include "../../../macros.h"

#if defined(WEBVIEW_PLATFORM_ANDROID)

#include <jni.h>

#include <string>

namespace webview {
namespace detail {
namespace android {

/// The process-wide JavaVM, published by JNI_OnLoad or by an explicit call to
/// webview::android::attach(). Every other helper here needs it to reach a
/// JNIEnv for the calling thread.
inline JavaVM *&vm_ref() noexcept {
  static JavaVM *vm{};
  return vm;
}

/// A global reference to the Activity the web view lives in. Global rather
/// than local: a local reference is only valid for the native call that
/// produced it, and this outlives many of them.
inline jobject &activity_ref() noexcept {
  static jobject activity{};
  return activity;
}

/// Attaches the calling thread to the VM if it is not already attached and
/// detaches it again on destruction. Native work happens on threads the VM
/// has never seen — a timer thread, a file worker — and JNI is unusable from
/// those until they are attached.
class scoped_env {
public:
  scoped_env() noexcept {
    auto *vm = vm_ref();
    if (!vm) {
      return;
    }
    if (vm->GetEnv(reinterpret_cast<void **>(&m_env), JNI_VERSION_1_6) ==
        JNI_OK) {
      return;
    }
    if (vm->AttachCurrentThread(&m_env, nullptr) == JNI_OK) {
      m_attached = true;
    } else {
      m_env = nullptr;
    }
  }

  ~scoped_env() {
    if (m_attached) {
      vm_ref()->DetachCurrentThread();
    }
  }

  scoped_env(const scoped_env &) = delete;
  scoped_env &operator=(const scoped_env &) = delete;
  scoped_env(scoped_env &&) = delete;
  scoped_env &operator=(scoped_env &&) = delete;

  JNIEnv *get() const noexcept { return m_env; }
  explicit operator bool() const noexcept { return m_env != nullptr; }
  JNIEnv *operator->() const noexcept { return m_env; }

private:
  JNIEnv *m_env{};
  bool m_attached{};
};

/// Owns a local reference and releases it. Local references are a finite
/// resource within one native call and leaking them aborts the VM once the
/// table fills, which is a confusing crash to debug.
class local_ref {
public:
  local_ref(JNIEnv *env, jobject obj) noexcept : m_env{env}, m_obj{obj} {}

  ~local_ref() {
    if (m_env && m_obj) {
      m_env->DeleteLocalRef(m_obj);
    }
  }

  local_ref(const local_ref &) = delete;
  local_ref &operator=(const local_ref &) = delete;
  local_ref(local_ref &&other) noexcept : m_env{other.m_env}, m_obj{other.m_obj} {
    other.m_obj = nullptr;
  }
  local_ref &operator=(local_ref &&) = delete;

  jobject get() const noexcept { return m_obj; }
  explicit operator bool() const noexcept { return m_obj != nullptr; }

private:
  JNIEnv *m_env{};
  jobject m_obj{};
};

/// Clears a pending Java exception and reports whether there was one. An
/// exception left pending makes the next JNI call abort the process, so every
/// call site that can throw checks.
inline bool clear_exception(JNIEnv *env) noexcept {
  if (!env || !env->ExceptionCheck()) {
    return false;
  }
  env->ExceptionDescribe();
  env->ExceptionClear();
  return true;
}

/// Converts a UTF-8 std::string to a Java string. The caller owns the local
/// reference that comes back.
inline jstring to_jstring(JNIEnv *env, const std::string &s) {
  return env->NewStringUTF(s.c_str());
}

/// Converts a Java string to UTF-8. Returns an empty string for null.
inline std::string to_string(JNIEnv *env, jstring s) {
  if (!s) {
    return {};
  }
  const char *chars = env->GetStringUTFChars(s, nullptr);
  if (!chars) {
    return {};
  }
  std::string out{chars};
  env->ReleaseStringUTFChars(s, chars);
  return out;
}

} // namespace android
} // namespace detail
} // namespace webview

#endif // defined(WEBVIEW_PLATFORM_ANDROID)
#endif // defined(__cplusplus) && !defined(WEBVIEW_HEADER)
#endif // WEBVIEW_PLATFORM_ANDROID_JNI_HH
