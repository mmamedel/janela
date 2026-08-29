// src-host/main.ts — your app's backend, compiled to native code by scriptc.
//
// Register commands here; the page calls them with `await janela.invoke(name, args)`.
// Handlers receive the args as JSON text and return JSON text (what the
// frontend promise resolves with).
//
// Gotcha inherited from scriptc 0.0.32: never use a bare FFI-backed call as a
// complete variable initializer — wrap it in any expression (`+ 0`). Plain
// TypeScript like everything in this file is unaffected.

import { readFileSync, statSync } from "node:fs";
import type { JanelaApp } from "./janela";

// Cap what we ship to the page — this is a viewer, not an editor.
const MAX_PREVIEW = 64 * 1024;

export function setup(app: JanelaApp): void {
  app.command("readFile", (argsJson) => {
    const a = JSON.parse(argsJson) as { path: string };
    try {
      const st = statSync(a.path);
      if (!st.isFile()) {
        return JSON.stringify({ ok: false, error: a.path + " is not a regular file" });
      }
      const text = readFileSync(a.path, "utf8");
      const truncated = text.length > MAX_PREVIEW;
      return JSON.stringify({
        ok: true,
        size: st.size,
        truncated,
        content: truncated ? text.slice(0, MAX_PREVIEW) : text,
      });
    } catch (e) {
      return JSON.stringify({ ok: false, error: (e as Error).message });
    }
  });

  app.command("add", (argsJson) => {
    const a = JSON.parse(argsJson) as { a: number; b: number };
    const sum = a.a + a.b;
    // Backend→frontend event, just to show the channel exists.
    app.emit("added", JSON.stringify(sum));
    return JSON.stringify(sum);
  });

  app.command("greet", (argsJson) => {
    const a = JSON.parse(argsJson) as { name: string };
    return JSON.stringify("Hello, " + a.name + " — from the native TS binary");
  });

  app.command("log", (argsJson) => {
    const a = JSON.parse(argsJson) as string;
    console.log("[host] page says:", a);
    return "null";
  });

  app.command("quit", (_argsJson) => {
    app.quit();
    return "null";
  });
}
