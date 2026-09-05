// @expect TS2345 Argument of type 'string' is not assignable to parameter of type 'MenuItem[]'
// The menu takes objects, not a shape someone can approximate with a literal
// or a bare string. Building an item is the only way to get one, which is what
// makes the handler and the entry impossible to separate.
import type { App } from "./contract.ts";

export function setup(app: App): void {
  app.setMenu("File");
}
