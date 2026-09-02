// @expect TS2345 '"addedd"' is not assignable to parameter of type '"added"'
import type { App } from "./contract.ts";
export function setup(app: App): void {
  app.emit("addedd", 1);
}
