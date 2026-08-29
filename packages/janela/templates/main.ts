// src-host/main.ts — your app's backend, compiled to native code by scriptc.
//
// Register commands here; the page calls them with `await janela.invoke(name, args)`.
// Handlers receive the args as JSON text and return JSON text (what the
// frontend promise resolves with).
//
// Gotcha inherited from scriptc 0.0.32: never use a bare FFI-backed call as a
// complete variable initializer — wrap it in any expression (`+ 0`). Plain
// TypeScript like everything in this file is unaffected.

import type { JanelaApp } from "./janela";

export function setup(app: JanelaApp): void {
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

  // An async command: answers later, without freezing the window. The page
  // still just does `await janela.invoke("wait", { ms: 1000 })`.
  app.commandAsync("wait", (argsJson, resolve) => {
    const a = JSON.parse(argsJson) as { ms: number };
    app.sleep(a.ms, () => {
      resolve(JSON.stringify("waited " + a.ms + "ms without blocking the UI"));
    });
  });

  // File I/O without freezing the window: the read happens on a worker thread
  // in the shim. Use this instead of node:fs readFileSync, which blocks the
  // host loop — and with it the whole UI — until the syscall returns.
  app.commandAsync("readFile", (argsJson, resolve) => {
    const a = JSON.parse(argsJson) as { path: string };
    app.readFileAsync(a.path, (err, text) => {
      if (err !== null) {
        resolve(JSON.stringify({ ok: false, error: err }));
        return;
      }
      resolve(JSON.stringify({ ok: true, length: text.length, text: text }));
    });
  });

  app.command("quit", (_argsJson) => {
    app.quit();
    return "null";
  });
}
