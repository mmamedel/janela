// @expect TS2554 Expected 2 arguments, but got 1
// The other half of the same guarantee: a command that DOES declare arguments
// still requires them. The rest-tuple in `invoke` must make the parameter
// optional only for commands whose arguments are exactly null.
import { createClient } from "janela/api";
import type { App } from "./contract.ts";

const client = createClient<App>();

export async function run(): Promise<void> {
  await client.invoke("add");
}
