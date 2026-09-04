// @expect TS2739 is missing the following properties from type 'MenuEntry'
// MenuEntry is a TOTAL record on purpose: an all-optional version infers as
// `{ label: string | undefined, … }`, and an array mixing a submenu, an item
// and a separator is then a union that scriptc refuses to re-tag (SC2003).
// The helpers exist so nobody writes a partial literal — and if they do, it is
// a type error here rather than a compile error deep in scriptc.
import type { App } from "./contract.ts";

export function setup(app: App): void {
  app.setMenu([{ label: "File" }]);
}
