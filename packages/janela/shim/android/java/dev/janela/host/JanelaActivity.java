package dev.janela.host;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;

/**
 * janela's Android entry point.
 *
 * <p>Android has no main(): the system creates this Activity and owns the
 * Looper. Everything janela does starts from onCreate, which hands the
 * Activity to the native shell — the mirror of the iOS shell, where UIKit owns
 * the loop and the app's TypeScript is a linked scriptc library we call into.
 *
 * <p>The file picker also lives here rather than in native code, because the
 * Storage Access Framework is reached through {@code startActivityForResult}
 * and answered on an Activity method. Native code cannot receive that: ART's
 * JNI {@code DefineClass} is unimplemented, so a class the framework can call
 * back into has to exist in the APK. The shell asks this class to open a
 * picker and gets the answer back through {@code nativeOnDialogResult}.
 */
public final class JanelaActivity extends Activity {
  static {
    System.loadLibrary("janela");
  }

  /** Matches the request code the shell passes; only one picker at a time. */
  private static final int PICK_REQUEST = 0x4a41;

  private static native void nativeOnCreate(Activity activity);

  /**
   * Hands a picker result to the shell.
   *
   * @param job the shell's dialog job id
   * @param ok false when the pick failed outright
   * @param payload a JSON array of copied paths, or an error message
   */
  private static native void nativeOnDialogResult(double job, boolean ok, String payload);

  /**
   * Resolves a content:// URI into a file inside the app's storage.
   *
   * <p>Implemented natively so the copy, the JSON and the error strings live
   * in one place shared with iOS, rather than being written twice.
   */
  private static native String nativeCopyUri(String uri, String displayName);

  private double pendingJob = -1;

  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    nativeOnCreate(this);
  }

  /**
   * Called from the shell (on the UI thread) to present a document picker.
   *
   * @param job the dialog job id to answer with
   * @param multiple allow more than one selection
   * @param mimeTypes MIME types to filter on, or an empty array for anything
   */
  public void openDocumentPicker(double job, boolean multiple, String[] mimeTypes) {
    if (pendingJob >= 0) {
      nativeOnDialogResult(job, false, "EBUSY: a file dialog is already open on this app");
      return;
    }
    try {
      Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
      intent.addCategory(Intent.CATEGORY_OPENABLE);
      // A concrete type is required; the extras narrow it when filters exist.
      intent.setType("*/*");
      if (mimeTypes != null && mimeTypes.length > 0) {
        intent.putExtra(Intent.EXTRA_MIME_TYPES, mimeTypes);
      }
      intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, multiple);
      pendingJob = job;
      startActivityForResult(intent, PICK_REQUEST);
    } catch (Throwable t) {
      pendingJob = -1;
      nativeOnDialogResult(job, false, "EIO: could not open a document picker: " + t);
    }
  }

  @Override
  protected void onActivityResult(int requestCode, int resultCode, Intent data) {
    super.onActivityResult(requestCode, resultCode, data);
    if (requestCode != PICK_REQUEST) {
      return;
    }
    double job = pendingJob;
    pendingJob = -1;
    if (job < 0) {
      return;
    }
    // Cancel is not an error: an empty array becomes null on the page, which
    // is what desktop answers.
    if (resultCode != Activity.RESULT_OK || data == null) {
      nativeOnDialogResult(job, true, "[]");
      return;
    }

    StringBuilder json = new StringBuilder("[");
    try {
      if (data.getClipData() != null) {
        int n = data.getClipData().getItemCount();
        for (int i = 0; i < n; i++) {
          Uri uri = data.getClipData().getItemAt(i).getUri();
          if (!appendCopied(json, uri, job)) {
            return;
          }
        }
      } else if (data.getData() != null) {
        if (!appendCopied(json, data.getData(), job)) {
          return;
        }
      }
    } catch (Throwable t) {
      nativeOnDialogResult(job, false, "EIO: could not read the picked selection: " + t);
      return;
    }
    json.append("]");
    nativeOnDialogResult(job, true, json.toString());
  }

  /**
   * The file's own name, so a copy is not named after the URI.
   *
   * A content:// URI's last segment is an opaque document id — picking
   * "pickme.txt" yielded a copy called "3A18" before this. OpenableColumns
   * carries the name the user actually saw.
   */
  private String displayName(Uri uri) {
    try (android.database.Cursor c =
        getContentResolver().query(uri, null, null, null, null)) {
      if (c != null && c.moveToFirst()) {
        int i = c.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME);
        if (i >= 0) {
          String name = c.getString(i);
          if (name != null && !name.isEmpty()) {
            return name;
          }
        }
      }
    } catch (Throwable ignored) {
      // Fall through: the shell names the copy from the URI instead.
    }
    return "";
  }

  /** Copies one URI and appends its quoted path; false if it failed. */
  private boolean appendCopied(StringBuilder json, Uri uri, double job) {
    if (uri == null) {
      return true;
    }
    String copied = nativeCopyUri(uri.toString(), displayName(uri));
    if (copied == null || copied.isEmpty()) {
      nativeOnDialogResult(
          job, false, "EIO: could not copy the picked file into the app's storage");
      return false;
    }
    if (json.length() > 1) {
      json.append(",");
    }
    json.append("\"").append(copied.replace("\\", "\\\\").replace("\"", "\\\"")).append("\"");
    return true;
  }
}
