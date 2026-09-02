// @expect TS2345 '"addd"' is not assignable to parameter of type '"add" | "greet" | "wait" | "quit"'
import type { App } from "./contract.ts";
export function setup(app: App): void {
  app.command("addd", () => 1);
}
