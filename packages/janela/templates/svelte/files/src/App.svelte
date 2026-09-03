<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { createClient } from "janela/api";
  // A type-only import of the host's contract. It is erased at compile time,
  // so no host code is bundled into the page — this is purely a type edge.
  import type { App } from "../src-host/main";

  const client = createClient<App>();

  let greeting = $state("booting…");
  let a = $state(2);
  let b = $state(40);
  let sum = $state("—");
  let waited = $state("—");
  let waiting = $state(false);
  let events = $state<string[]>([]);
  let path = $state("janela.conf.json");
  let title = $state("__NAME__ — renamed");
  let fileOut = $state("—");

  // The event name is checked against the contract and `value` is inferred.
  // `on` returns a disposer.
  const off = client.on("added", (value) => {
    events = [`host emitted 'added': ${value}`, ...events];
  });
  onDestroy(off);

  onMount(async () => {
    greeting = await client.invoke("greet", { name: "__NAME__" });
    await client.invoke("log", "page loaded");
  });

  async function add() {
    sum = `add(${a}, ${b}) → ${await client.invoke("add", { a: Number(a), b: Number(b) })}`;
  }

  async function wait() {
    waiting = true;
    waited = "waiting… try add, it still answers";
    waited = await client.invoke("wait", { ms: 2000 });
    waiting = false;
  }

  async function read() {
    const r = await client.invoke("readFile", { path });
    fileOut = r.ok ? `${path} — ${r.length} chars\n\n${r.text.slice(0, 400)}` : `error: ${r.error}`;
  }

  // The native open dialog. The window keeps serving other commands while the
  // user is deciding.
  async function pick() {
    const r = await client.invoke("openFile");
    if (!r.ok) fileOut = `error: ${r.error}`;
    else if (r.cancelled) fileOut = "cancelled";
    else fileOut = `${r.path} — ${r.length} chars\n\n${r.text.slice(0, 400)}`;
  }
</script>

<main>
  <header>
    <div class="mark" aria-hidden="true">
      <div class="bar"><i></i><i></i><i></i></div>
      <div class="pane"></div>
    </div>
    <h1>__NAME__</h1>
    <p class="sub">TypeScript, compiled to a native binary. No Rust, no Node, no Electron.</p>
  </header>

  <p class="greeting">{greeting}</p>

  <div class="grid">
    <section class="card">
      <h2>Typed commands</h2>
      <p class="why">
        The name, the arguments and the result are all checked at compile time — no codegen,
        because both sides are TypeScript.
      </p>
      <div class="row">
        <input type="number" bind:value={a} aria-label="first number" />
        <span aria-hidden="true">+</span>
        <input type="number" bind:value={b} aria-label="second number" />
        <button class="primary" onclick={add}>add</button>
      </div>
      <p class="result" class:filled={sum !== "—"}>{sum}</p>
      <h3>Events from the host</h3>
      <ul class="events">
        {#each events as e, i (i)}
          <li>{e}</li>
        {/each}
      </ul>
    </section>

    <section class="card">
      <h2>Async without blocking</h2>
      <p class="why">
        The window keeps answering while this is pending: the dot keeps moving and
        <strong>add</strong> still works.
      </p>
      <div class="row">
        <button disabled={waiting} onclick={wait}>wait 2s</button>
        {#if waiting}<span><span class="pulse"></span></span>{/if}
      </div>
      <p class="result" class:filled={waited !== "—"}>{waited}</p>
    </section>

    <section class="card wide">
      <h2>Files and the window</h2>
      <p class="why">
        Reads run on a worker thread, so a large file never freezes the window. The dialog is the
        real native one.
      </p>
      <div class="row">
        <input class="grow" type="text" bind:value={path} aria-label="file to read" />
        <button onclick={read}>read</button>
        <button onclick={pick}>pick a file…</button>
        <input class="grow" type="text" bind:value={title} aria-label="window title" />
        <button onclick={() => client.invoke("setTitle", { title })}>set title</button>
      </div>
      <pre class="result" class:filled={fileOut !== "—"}>{fileOut}</pre>
    </section>
  </div>

  <footer>
    <span>
      Edit <code>src/App.svelte</code> for the page and <code>src-host/main.ts</code> for the
      commands.
    </span>
    <button onclick={() => client.invoke("quit")}>Quit</button>
  </footer>
</main>
