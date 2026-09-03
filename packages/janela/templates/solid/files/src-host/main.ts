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
  quit: () => void;
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

  app.command("quit", (_args) => {
    app.quit();
    return null;
  });
}
