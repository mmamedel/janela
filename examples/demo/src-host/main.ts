// src-host/main.ts — your app's backend, compiled to native code by scriptc.
//
// Register commands here; the page calls them with `await janela.invoke(name, args)`.
// Handlers take the arguments as a value and return a value; the runtime owns
// JSON at the boundary.
//
// Gotcha inherited from scriptc: never use a bare FFI-backed call as a
// complete variable initializer — wrap it in any expression (`+ 0`). Plain
// TypeScript like everything in this file is unaffected.

import type { JanelaApp } from "./janela";

// Cap what we ship to the page — this is a viewer, not an editor.
const MAX_PREVIEW = 64 * 1024;

export function setup(app: JanelaApp): void {
  // readFileAsync, not node:fs readFileSync: the syscall runs on a shim worker
  // thread, so the window keeps painting and other commands keep answering
  // even while a large file is being read.
  app.commandAsync("readFile", (args, resolve) => {
    const a = args as { path: string };
    app.readFileAsync(a.path, (err, text) => {
      if (err !== null) {
        resolve({ ok: false, error: err });
        return;
      }
      const truncated = text.length > MAX_PREVIEW;
      resolve({
        ok: true,
        size: text.length,
        truncated,
        content: truncated ? text.slice(0, MAX_PREVIEW) : text,
      });
    });
  });

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

  // Async: parks the page's promise and answers on a later turn of the host
  // loop, so the window keeps painting and other commands keep answering.
  app.commandAsync("wait", (args, resolve) => {
    const a = args as { ms: number };
    app.sleep(a.ms, () => {
      resolve("waited " + a.ms + "ms without blocking the UI");
    });
  });

  // CPU work sliced across turns: same effect, for work that cannot just wait.
  app.commandAsync("countTo", (args, resolve) => {
    const a = args as { n: number };
    let acc = 0;
    let done = 0;
    const step = (): void => {
      const end = done + 2000000 < a.n ? done + 2000000 : a.n;
      for (let i = done; i < end; i++) acc = acc + 1;
      done = end;
      if (done < a.n) app.defer(step);
      else resolve(acc);
    };
    app.defer(step);
  });

  // Native "open" dialog + the async reader: pick a file, then read it
  // without the window freezing at either step.
  app.commandAsync("openFile", (_args, resolve) => {
    app.openFileDialog(
      {
        title: "Pick a text file",
        filters: [
          { name: "Text", extensions: ["txt", "md", "json"] },
          { name: "All files", extensions: ["*"] },
        ],
      },
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
              : { ok: true, path: paths[0], length: text.length, text: text.slice(0, 2000) },
          );
        });
      },
    );
  });

  // Native "save" dialog. The path comes back; writing it is a separate step,
  // so the app decides what (and whether) to write.
  app.commandAsync("saveAs", (args, resolve) => {
    const a = args as { text: string };
    app.saveFileDialog(
      { title: "Save as", defaultName: "untitled.txt" },
      (path, err) => {
        if (err !== undefined || path === null) {
          resolve({ ok: err === undefined, cancelled: path === null, error: err });
          return;
        }
        app.writeFileAsync(path, a.text, (werr) => {
          resolve(werr !== null ? { ok: false, error: werr } : { ok: true, path: path });
        });
      },
    );
  });

  app.command("window", (args) => {
    const a = args as { title?: string; width?: number; height?: number; fullscreen?: boolean };
    if (a.title !== undefined) app.setTitle(a.title);
    if (a.width !== undefined && a.height !== undefined) app.setSize(a.width, a.height, 0);
    if (a.fullscreen !== undefined) app.setFullscreen(a.fullscreen);
    return "ok";
  });

  app.command("quit", (_args) => {
    app.quit();
  });
}
