// @expect TS2339 Property 'onMenu' does not exist on type
// app.onMenu is gone: items carry their own handlers, so there is nothing left
// to dispatch by string. Pinned so it cannot quietly come back.
import type { App } from "./contract.ts";

export function setup(app: App): void {
  app.onMenu((id: string) => void id);
}
