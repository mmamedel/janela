// @expect TS2551 Property 'setChecked' does not exist on type 'MenuItem'
// A tick is not something any item can carry: GTK needs GtkCheckMenuItem, a
// different widget chosen at construction. macOS and Windows would allow it,
// so this would be a method that works on two platforms and silently does
// nothing on the third — absent is better than surprising.
import { menuItem } from "janela/host";
import type { App } from "./contract.ts";

export function setup(app: App): void {
  const save = menuItem("Save", "CmdOrCtrl+S", () => {});
  app.setMenu([save]);
  save.setChecked(true);
}
