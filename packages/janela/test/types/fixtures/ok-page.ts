// @expect-ok
import { createClient } from "janela/api";
import type { App } from "./contract.ts";

const client = createClient<App>();

export async function run(): Promise<void> {
  // The result is the declared type, and assigning it to that type compiles.
  const sum: number = await client.invoke("add", { a: 2, b: 40 });
  const greeting: string = await client.invoke("greet", { name: "x" });
  // A zero-argument command needs no argument at all — and still accepts an
  // explicit null, so pages written before that was allowed keep compiling.
  await client.invoke("quit");
  await client.invoke("quit", null);
  const off = client.on("added", (payload: number) => void payload);
  off();
  void sum;
  void greeting;
}
