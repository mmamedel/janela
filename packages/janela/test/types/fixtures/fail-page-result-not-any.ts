// @expect TS2322 Type 'number' is not assignable to type 'string'
// The negative control. If the contract types ever degrade to `any`, this
// assignment compiles and the suite fails for the right reason.
import { createClient } from "janela/api";
import type { App } from "./contract.ts";
const client = createClient<App>();
export async function run(): Promise<void> {
  const wrong: string = await client.invoke("add", { a: 1, b: 2 });
  void wrong;
}
