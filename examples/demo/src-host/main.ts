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

  // Async: parks the page's promise and answers on a later turn of the host
  // loop, so the window keeps painting and other commands keep answering.
  app.commandAsync("wait", (argsJson, resolve) => {
    const a = JSON.parse(argsJson) as { ms: number };
    app.sleep(a.ms, () => {
      resolve(JSON.stringify("waited " + a.ms + "ms without blocking the UI"));
    });
  });

  // CPU work sliced across turns: same effect, for work that cannot just wait.
  app.commandAsync("countTo", (argsJson, resolve) => {
    const a = JSON.parse(argsJson) as { n: number };
    let acc = 0;
    let done = 0;
    const step = (): void => {
      const end = done + 2000000 < a.n ? done + 2000000 : a.n;
      for (let i = done; i < end; i++) acc = acc + 1;
      done = end;
      if (done < a.n) app.defer(step);
      else resolve(JSON.stringify(acc));
    };
    app.defer(step);
  });

  app.command("quit", (_argsJson) => {
    app.quit();
    return "null";
  });
}
