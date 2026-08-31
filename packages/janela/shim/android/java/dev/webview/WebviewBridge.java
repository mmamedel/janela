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

package dev.webview;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * The Java half of webview's Android backend.
 *
 * <p>This class exists because android.webkit.WebView is a Java API with no C
 * surface, and because every framework callback the backend needs — a message
 * from the page, a page-start notification, a Runnable on the UI thread —
 * arrives as a virtual Java method. Native code cannot define a class to
 * receive one: ART's JNI DefineClass is unimplemented, and the framework types
 * involved are abstract classes rather than interfaces, so a reflection proxy
 * does not help either.
 *
 * <p>The native side finds this class by name and wires the three {@code
 * native} methods below with RegisterNatives, so the class may be relocated by
 * defining {@code WEBVIEW_ANDROID_BRIDGE_CLASS} to a different path.
 */
public final class WebviewBridge {
  private WebviewBridge() {}

  private static final Handler HANDLER = new Handler(Looper.getMainLooper());

  /** Name the page-side post function looks the interface up under. */
  private static final String JS_INTERFACE = "__webview__host";

  private static native void nativePost(long token);

  private static native void nativeOnMessage(String message);

  private static native void nativeOnPageStarted();

  /**
   * Runs a unit of native work on the UI thread. The native side keeps the
   * work itself and passes only a token, so nothing has to cross the boundary
   * but a long.
   */
  public static void post(final long token) {
    HANDLER.post(
        new Runnable() {
          @Override
          public void run() {
            nativePost(token);
          }
        });
  }

  /** Builds the web view the backend drives. Must run on the UI thread. */
  @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
  public static WebView createWebView(Activity activity, boolean debug) {
    WebView webView = new WebView(activity);
    webView.getSettings().setJavaScriptEnabled(true);
    webView.getSettings().setDomStorageEnabled(true);
    if (debug) {
      WebView.setWebContentsDebuggingEnabled(true);
    }
    webView.addJavascriptInterface(new Ipc(), JS_INTERFACE);
    webView.setWebViewClient(
        new WebViewClient() {
          @Override
          public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
            super.onPageStarted(view, url, favicon);
            // The framework has no document-start script API, so the backend
            // replays its user scripts from here.
            nativeOnPageStarted();
          }
        });
    return webView;
  }

  /** Installs the web view as the Activity's whole content. */
  public static void setContentView(final Activity activity, final WebView webView) {
    activity.setContentView(webView);
  }

  /** Adds the web view to an embedder's existing view group. */
  public static void addToView(View parent, WebView webView) {
    ((ViewGroup) parent)
        .addView(
            webView,
            new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
  }

  /** Closes the Activity. The process may outlive it; Android decides that. */
  public static void finishActivity(Activity activity) {
    activity.finish();
  }

  /** Sets the Activity label, which shows in the task switcher. */
  public static void setTitle(Activity activity, String title) {
    activity.setTitle(title);
  }

  /** The object the page posts messages to. */
  private static final class Ipc {
    @JavascriptInterface
    public void postMessage(String message) {
      nativeOnMessage(message);
    }
  }
}
