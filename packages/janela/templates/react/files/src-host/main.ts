// src-host/main.ts — your app's backend, compiled to native code by scriptc.
//
// The table below is the single declaration of what this app exposes, and
// `App` names an app that carries it. The frontend imports `App` with
// `import type`, so the page is checked against these exact types — command
// names, argument shapes and results — with no code generation and nothing to
// keep in sync.
//
// A command that returns nothing is declared `() => void` and its handler
// returns `null`; every command answers the page's promise with a value.

import type { JanelaApp } from "janela/host";

/** Every command this app answers. Declared once; the page checks against it. */
export type AppCommands = {
  greet: (args: { name: string }) => string;
  log: (args: string) => void;
};

/**
 * Every event this app emits, and what each one carries. Empty to start with —
 * add one and `app.emit` is checked against it, as is `client.on` in the page.
 */
export type AppEvents = {};

/** The contract the page imports with `import type { App } from "../src-host/main"`. */
export type App = JanelaApp<AppCommands, AppEvents>;

// Typing the app with the contract is what makes `app.command` checked: the
// name must be one of the declared ones, `args` is inferred from it, and the
// return value has to match.
export function setup(app: App): void {
  app.command("greet", (args) => {
    return "Hello, " + args.name + "! You've been greeted from a native TypeScript binary.";
  });

  // Anything the host logs goes to the terminal that `janela dev` runs in.
  app.command("log", (args) => {
    console.log("[host] page says:", args);
    return null;
  });
}
