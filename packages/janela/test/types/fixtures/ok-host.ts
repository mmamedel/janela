// @expect-ok
import type { App } from "./contract.ts";

export function setup(app: App): void {
  app.command("add", (args) => args.a + args.b);
  app.command("greet", (args) => "hi " + args.name);
  app.command("quit", () => null);
  app.commandAsync("wait", (args, resolve) => {
    app.sleep(args.ms, () => resolve("waited"));
  });
  app.emit("added", 42);
}
