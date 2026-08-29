<script>
  let greeting = $state("…");
  let a = $state(2);
  let b = $state(40);
  let sum = $state(null);
  let events = $state([]);

  // Backend→frontend events. The payload arrives as a value.
  janela.listen("added", (value) => (events = [`host emitted: ${value}`, ...events]));

  janela.invoke("greet", { name: "__NAME__" }).then((g) => (greeting = g));

  async function add() {
    sum = await janela.invoke("add", { a: Number(a), b: Number(b) });
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
