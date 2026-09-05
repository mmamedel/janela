// @expect-ok
// Menu items are objects carrying their own handler. There are no ids to
// declare, match or mistype — the closure is attached where you already know
// what the item does.
import { menuItem, menuSeparator, submenu } from "janela/host";
import type { App } from "./contract.ts";

export function setup(app: App): void {
  const save = menuItem("Save", "CmdOrCtrl+S", () => {});

  const applied: boolean = app.setMenu([
    submenu("File", [
      menuItem("Open…", "CmdOrCtrl+O", () => {}),
      menuSeparator(),
      save,
      submenu("Recent", [menuItem("Clear", "", () => {})]),
    ]),
  ]);
  void applied;

  // Live, without rebuilding the bar.
  save.setEnabled(false);
  save.setChecked(true);
  save.setLabel("Save As…");
}
