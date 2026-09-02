// @expect TS2322 Type 'number' is not assignable to type 'string'
import type { App } from "./contract.ts";
export function setup(app: App): void {
  app.command("greet", () => 42);
}
