// @expect TS2322 Type 'string' is not assignable to type 'number'
import { createClient } from "janela/api";
import type { App } from "./contract.ts";
const client = createClient<App>();
export const p = client.invoke("add", { a: 1, b: "two" });
