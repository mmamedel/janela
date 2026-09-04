// @expect-ok
// The declarative menu API: a tree of values built with the helpers, and a
// click handler that receives the entry's id.
import { menuItem, menuSeparator, submenu } from "janela/host";
import type { App } from "./contract.ts";

export function setup(app: App): void {
  const applied: boolean = app.setMenu([
    submenu("File", [
      menuItem("Open…", "open", "CmdOrCtrl+O"),
      menuSeparator(),
      submenu("Recent", [menuItem("Clear", "clear", "")]),
    ]),
  ]);
  void applied;
  app.onMenu((id: string) => void id);
}
