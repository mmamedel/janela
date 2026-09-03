// src-host/main.ts — your app's backend, compiled to native code by scriptc.
//
// Register commands here; the page calls them with `await janela.invoke(name, args)`.
// Handlers take the arguments as a value and return a value — the runtime owns
// JSON at the boundary, so there is no parsing or stringifying to do here.
//
// This template has no bundler, so it uses the untyped `JanelaApp`. The
// framework templates declare a contract instead and the page is checked
// against it; see `janela init --template vue`.

import type { JanelaApp } from "janela/host";

export function setup(app: JanelaApp): void {
  app.command("greet", (args) => {
    const a = args as { name: string };
    return "Hello, " + a.name + "! You've been greeted from a native TypeScript binary.";
  });

  // Anything the host logs goes to the terminal that `janela dev` runs in.
  app.command("log", (args) => {
    console.log("[host] page says:", args as string);
  });
}
