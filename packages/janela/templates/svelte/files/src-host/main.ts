// src-host/main.ts — your app's backend, compiled to native code by scriptc.
//
// Register commands here; the page calls them with `await janela.invoke(name, args)`.
// Handlers take the arguments as a value and return a value — the runtime owns
// JSON at the boundary, so there is no parsing or stringifying to do here.
//
// Gotcha inherited from scriptc: never use a bare FFI-backed call as a
// complete variable initializer — wrap it in any expression (`+ 0`). Plain
// TypeScript like everything in this file is unaffected.

import type { JanelaApp } from "./janela";

export function setup(app: JanelaApp): void {
  app.command("add", (args) => {
    const a = args as { a: number; b: number };
    const sum = a.a + a.b;
    // Backend→frontend event: the page listens with janela.listen("added", …).
    app.emit("added", sum);
    return sum;
  });

  app.command("greet", (args) => {
    const a = args as { name: string };
    return "Hello, " + a.name + " — from the native TS binary";
  });

  app.command("log", (args) => {
    console.log("[host] page says:", args as string);
  });

  // An async command: answers later, without freezing the window.
  app.commandAsync("wait", (args, resolve) => {
    const a = args as { ms: number };
    app.sleep(a.ms, () => {
      resolve("waited " + a.ms + "ms without blocking the UI");
    });
  });

  app.command("quit", () => {
    app.quit();
  });
}
