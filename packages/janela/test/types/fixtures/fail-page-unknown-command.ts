// @expect TS2345 '"addd"' is not assignable to parameter of type
// (The union's member order is not guaranteed by TypeScript and shifted once
//  under an unrelated edit, so the listing is deliberately not asserted.)
import { createClient } from "janela/api";
import type { App } from "./contract.ts";
const client = createClient<App>();
export const p = client.invoke("addd", { a: 1, b: 2 });
