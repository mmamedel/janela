// @expect TS2339 Property 'nope' does not exist on type '{ a: number; b: number; }'
import type { App } from "./contract.ts";
export function setup(app: App): void {
  app.command("add", (args) => args.nope);
}
