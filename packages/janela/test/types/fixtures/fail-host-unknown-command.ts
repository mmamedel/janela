// @expect TS2345 '"addd"' is not assignable to parameter of type
// (The union's member order is not guaranteed by TypeScript and shifted once
//  under an unrelated edit, so the listing is deliberately not asserted.)
import type { App } from "./contract.ts";
export function setup(app: App): void {
  app.command("addd", () => 1);
}
