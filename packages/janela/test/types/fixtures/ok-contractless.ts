// @expect-ok
// The vanilla path: no contract, so any name is accepted and args is unknown.
import type { JanelaApp } from "janela/host";

export function setup(app: JanelaApp): void {
  app.command("anything", (args) => String(args));
  app.emit("whatever", 1);
}
