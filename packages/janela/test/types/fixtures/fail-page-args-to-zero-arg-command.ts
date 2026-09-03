// @expect TS2345 Argument of type '{ now: boolean; }' is not assignable to parameter of type 'null | undefined'
// Omitting the argument of a zero-argument command is allowed; inventing one
// is not. Without this, making the parameter optional would have quietly
// widened it to accept anything, which is the mistake that turns a typed
// contract back into `invoke(name, any)`.
import { createClient } from "janela/api";
import type { App } from "./contract.ts";

const client = createClient<App>();

export async function run(): Promise<void> {
  await client.invoke("quit", { now: true });
}
