// @expect-ok
// The 0.5.x-0.7.x record form must keep compiling; Norm is idempotent.
import type { JanelaApp } from "janela/host";

type LegacyCommands = { add: { args: { a: number; b: number }; result: number } };

export function setup(app: JanelaApp<LegacyCommands, { added: number }>): void {
  app.command("add", (args) => args.a + args.b);
  app.emit("added", 7);
}
