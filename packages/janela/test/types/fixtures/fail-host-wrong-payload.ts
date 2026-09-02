// @expect TS2345 Argument of type 'string' is not assignable to parameter of type 'number'
import type { App } from "./contract.ts";
export function setup(app: App): void {
  app.emit("added", "not a number");
}
