// @expect TS2345 '"addd"' is not assignable to parameter of type '"add" | "greet" | "wait" | "quit"'
import { createClient } from "janela/api";
import type { App } from "./contract.ts";
const client = createClient<App>();
export const p = client.invoke("addd", { a: 1, b: 2 });
