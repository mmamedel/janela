// @expect TS2345 Argument of type 'number' is not assignable to parameter of type 'string'
import type { App } from "./contract.ts";
export function setup(app: App): void {
  app.commandAsync("wait", (_args, resolve) => resolve(42));
}
