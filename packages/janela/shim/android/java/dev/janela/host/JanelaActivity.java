package dev.janela.host;

import android.app.Activity;
import android.os.Bundle;

/**
 * janela's Android entry point.
 *
 * <p>Android has no main(): the system creates this Activity and owns the
 * Looper. Everything janela does starts from onCreate, which hands the
 * Activity to the native shell — the mirror of the iOS shell, where UIKit owns
 * the loop and the app's TypeScript is a linked scriptc library we call into.
 */
public final class JanelaActivity extends Activity {
  static {
    System.loadLibrary("janela");
  }

  private static native void nativeOnCreate(Activity activity);

  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    nativeOnCreate(this);
  }
}
