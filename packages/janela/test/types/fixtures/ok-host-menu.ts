// @expect-ok
// Menu items are objects carrying their own handler. There are no ids to
// declare, match or mistype — the closure is attached where you already know
// what the item does, and the platform's own actions are just functions you
// call from inside it.
import { menuCheckItem, menuItem, menuSeparator, predefined, submenu } from "janela/host";
import type { App } from "./contract.ts";

export function setup(app: App): void {
  const save = menuItem("Save", "CmdOrCtrl+S", () => {});
  const dark = menuCheckItem("Dark mode", "", () => {});

  const applied: boolean = app.setMenu([
    submenu("File", [
      menuItem("Open…", "CmdOrCtrl+O", () => {}),
      menuSeparator(),
      save,
      // A platform action, called like anything else — and composable, which
      // a fixed "predefined item" could never be.
      menuItem("Save and close", "", () => {
        save.setEnabled(false);
        predefined.close();
      }),
    ]),
    submenu("Edit", [
      menuItem("Undo", "CmdOrCtrl+Z", () => void predefined.undo()),
      menuItem("Copy", "CmdOrCtrl+C", () => void predefined.copy()),
      menuItem("Paste", "CmdOrCtrl+V", () => void predefined.paste()),
    ]),
    submenu("Options", [dark]),
  ]);
  void applied;

  save.setEnabled(false);
  save.setLabel("Save As…");
  dark.setChecked(true);
}
