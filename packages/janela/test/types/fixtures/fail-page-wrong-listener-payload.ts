// @expect TS2345 is not assignable to parameter of type '(payload: number) => void'
import { createClient } from "janela/api";
import type { App } from "./contract.ts";
const client = createClient<App>();
export const off = client.on("added", (payload: string) => void payload);
