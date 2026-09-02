// @expect TS2345 '"addedd"' is not assignable to parameter of type '"added"'
import { createClient } from "janela/api";
import type { App } from "./contract.ts";
const client = createClient<App>();
export const off = client.on("addedd", () => {});
