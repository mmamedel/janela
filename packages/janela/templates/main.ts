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
import { menuItem, menuSeparator, submenu, predefined } from "janela/host";

export function setup(app: JanelaApp): void {
  // A menu bar. Items carry their own handlers — there are no ids to declare
  // or match — and `predefined` is the platform's own behaviour, callable like
  // any other function.
  //
  // On macOS the standard submenus (App, Edit, View, Window) are kept around
  // whatever you declare here, so this adds File without costing the app ⌘Q or
  // ⌘V. Windows and Linux need no such floor: their editing keys belong to the
  // webview, and Alt+F4 to the window manager.
  app.setMenu([
    submenu("File", [
      menuItem("Say hello", "CmdOrCtrl+G", () => {
        console.log("[host] hello from the menu");
      }),
      menuSeparator(),
      menuItem("Close", "CmdOrCtrl+W", () => predefined.close()),
    ]),
  ]);

  app.command("greet", (args) => {
    const a = args as { name: string };
    return "Hello, " + a.name + "! You've been greeted from a native TypeScript binary.";
  });

  // Anything the host logs goes to the terminal that `janela dev` runs in.
  app.command("log", (args) => {
    console.log("[host] page says:", args as string);
  });
}
