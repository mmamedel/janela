<script lang="ts">
  import { createClient } from "janela/api";
  // Type-only import of the host contract: erased at compile time, so no
  // host code is bundled into the page.
  import type { App as Contract } from "../src-host/main";

  const client = createClient<Contract>();

  let greeting = $state("…");
  let a = $state(2);
  let b = $state(40);
  let sum = $state<number | null>(null);
  let events = $state<string[]>([]);

  // Backend→frontend events. The payload arrives as a value, and the generic
  // says which value.
  client.on("added", (value) => (events = [`host emitted: ${value}`, ...events]));

  client.invoke("greet", { name: "__NAME__" }).then((g) => (greeting = g));

  async function add() {
    sum = await client.invoke("add", { a: Number(a), b: Number(b) });
  }
</script>

<h1>{greeting}</h1>
<p>
  <input type="number" bind:value={a} /> +
  <input type="number" bind:value={b} />
  <button onclick={add}>add</button>
  {#if sum !== null}<span> = {sum}</span>{/if}
</p>
<ul>
  {#each events as e}<li>{e}</li>{/each}
</ul>

<style>
  :global(body) { font: 16px -apple-system, system-ui, sans-serif; padding: 2rem; }
  input { width: 5em; }
  ul { color: #666; font-size: 13px; }
</style>
