// src-host/main.ts — your app's backend, compiled to native code by scriptc.
//
// The two tables below are the single declaration of what this app exposes,
// and `App` names an app that carries them. The frontend imports `App` with
// `import type`, so the page is checked against these exact types — command
// names, argument shapes, results and event payloads — with no code
// generation and nothing to keep in sync.
//
// A command that returns nothing is declared `() => void` and its handler
// returns `null`; every command answers the page's promise with a value.

import type { JanelaApp } from "janela/host";

/** Every command this app answers. Declared once; the page checks against it. */
export type AppCommands = {
  add: (args: { a: number; b: number }) => number;
  greet: (args: { name: string }) => string;
  log: (args: string) => void;
  wait: (args: { ms: number }) => string;
  readFile: (args: { path: string }) => ReadResult;
  openFile: () => PickResult;
  setTitle: (args: { title: string }) => void;
  quit: () => void;
};

/**
 * Results are declared as TOTAL records rather than unions of shapes: every
 * field is always present, and `error` is null on success. A discriminated
 * union would read better in isolation, but the page would then have to narrow
 * before touching `text` — and the point of this template is to show the type
 * edge working, not to teach narrowing.
 */
export type ReadResult = { ok: boolean; error: string | null; length: number; text: string };
export type PickResult = {
  ok: boolean;
  error: string | null;
  cancelled: boolean;
  path: string;
  length: number;
  text: string;
};

/** Every event this app emits, and what each one carries. */
export type AppEvents = {
  added: number;
};

/** The contract the page imports with `import type { App } from "../src-host/main"`. */
export type App = JanelaApp<AppCommands, AppEvents>;

// Typing the app with the contract is what makes `app.command` checked: the
// name must be one of the declared ones, `args` is inferred from it, and the
// return value has to match. Same for `app.emit`.
export function setup(app: App): void {
  app.command("add", (args) => {
    const sum = args.a + args.b;
    app.emit("added", sum);
    return sum;
  });

  app.command("greet", (args) => {
    return "Hello, " + args.name + " — from the native TS binary";
  });

  app.command("log", (args) => {
    console.log("[host] page says:", args);
    return null;
  });

  // An async command: answers later, without freezing the window.
  app.commandAsync("wait", (args, resolve) => {
    app.sleep(args.ms, () => {
      resolve("waited " + args.ms + "ms without blocking the UI");
    });
  });

  // File I/O without freezing the window: the read happens on a worker thread
  // in the shim. Use this instead of node:fs readFileSync, which blocks the
  // host loop — and with it the whole UI — until the syscall returns.
  app.commandAsync("readFile", (args, resolve) => {
    app.readFileAsync(args.path, (err, text) => {
      // Annotated, not inferred: a bare `null` in a returned literal infers as
      // `null | undefined`, which does not lift into the declared
      // `string | null` (scriptc SC2002).
      const answer: ReadResult =
        err !== null
          ? { ok: false, error: err, length: 0, text: "" }
          : { ok: true, error: null, length: text.length, text: text };
      resolve(answer);
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
          const failed: PickResult = {
            ok: false, error: err, cancelled: false, path: "", length: 0, text: "",
          };
          resolve(failed);
          return;
        }
        if (paths === null) {
          const cancelled: PickResult = {
            ok: true, error: null, cancelled: true, path: "", length: 0, text: "",
          };
          resolve(cancelled);
          return;
        }
        app.readFileAsync(paths[0], (rerr, text) => {
          const answer: PickResult =
            rerr !== null
              ? { ok: false, error: rerr, cancelled: false, path: paths[0], length: 0, text: "" }
              : {
                  ok: true,
                  error: null,
                  cancelled: false,
                  path: paths[0],
                  length: text.length,
                  text: text,
                };
          resolve(answer);
        });
      },
    );
  });

  // The window is yours to change at runtime, not just at startup.
  app.command("setTitle", (args) => {
    app.setTitle(args.title);
    return null;
  });

  app.command("quit", (_args) => {
    app.quit();
    return null;
  });
}
