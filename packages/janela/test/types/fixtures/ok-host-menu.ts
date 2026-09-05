// @expect-ok
// Menu items are objects carrying their own handler. There are no ids to
// declare, match or mistype — the closure is attached where you already know
// what the item does.
import { menuCheckItem, menuItem, menuSeparator, submenu } from "janela/host";
import type { App } from "./contract.ts";

export function setup(app: App): void {
  const save = menuItem("Save", "CmdOrCtrl+S", () => {});
  // A tick needs a check item: GTK decides that at construction.
  const dark = menuCheckItem("Dark mode", "", () => {});

  const applied: boolean = app.setMenu([
    submenu("File", [
      menuItem("Open…", "CmdOrCtrl+O", () => {}),
      menuSeparator(),
      save,
      submenu("Recent", [menuItem("Clear", "", () => {})]),
    ]),
    submenu("Options", [dark]),
  ]);
  void applied;

  // Live, without rebuilding the bar.
  save.setEnabled(false);
  save.setLabel("Save As…");
  dark.setChecked(true);
}
