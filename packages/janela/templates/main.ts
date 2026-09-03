// src-host/main.ts — your app's backend, compiled to native code by scriptc.
//
// Register commands here; the page calls them with `await janela.invoke(name, args)`.
// Handlers take the arguments as a value and return a value — the runtime owns
// JSON at the boundary, so there is no parsing or stringifying to do here.

import type { JanelaApp } from "janela/host";

export function setup(app: JanelaApp): void {
  app.command("add", (args) => {
    const a = args as { a: number; b: number };
    const sum = a.a + a.b;
    // Backend→frontend event, just to show the channel exists.
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

  // An async command: answers later, without freezing the window. The page
  // still just does `await janela.invoke("wait", { ms: 1000 })`.
  app.commandAsync("wait", (args, resolve) => {
    const a = args as { ms: number };
    app.sleep(a.ms, () => {
      resolve("waited " + a.ms + "ms without blocking the UI");
    });
  });

  // File I/O without freezing the window: the read happens on a worker thread
  // in the shim. Use this instead of node:fs readFileSync, which blocks the
  // host loop — and with it the whole UI — until the syscall returns.
  app.commandAsync("readFile", (args, resolve) => {
    const a = args as { path: string };
    app.readFileAsync(a.path, (err, text) => {
      if (err !== null) {
        resolve({ ok: false, error: err });
        return;
      }
      resolve({ ok: true, length: text.length, text: text });
    });
  });

  // The native "open" dialog, paired with the reader above — picking a file is
  // what makes readFileAsync useful. commandAsync is the right shape here: the
  // page's promise stays parked while the user takes as long as they like, and
  // the window carries on serving other calls meanwhile.
  app.commandAsync("openFile", (_args, resolve) => {
    app.openFileDialog(
      { title: "Pick a file", filters: [{ name: "Text", extensions: ["txt", "md"] }] },
      (paths, err) => {
        if (err !== undefined) {
          resolve({ ok: false, error: err });
          return;
        }
        if (paths === null) {
          resolve({ ok: true, cancelled: true });
          return;
        }
        app.readFileAsync(paths[0], (rerr, text) => {
          resolve(
            rerr !== null
              ? { ok: false, error: rerr }
              : { ok: true, path: paths[0], length: text.length, text: text },
          );
        });
      },
    );
  });

  // The window is yours to change at runtime, not just at startup.
  app.command("setTitle", (args) => {
    app.setTitle((args as { title: string }).title);
  });

  app.command("quit", (_args) => {
    app.quit();
  });
}
