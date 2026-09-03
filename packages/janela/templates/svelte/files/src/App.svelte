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
    <svg class="mark" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 970.64 970.64" role="img" aria-label="janela"><path fill="currentColor" d="M970.64,485.32c0,268.03-217.28,485.32-485.32,485.32S0,753.35,0,485.32,217.28,0,485.32,0s485.32,217.28,485.32,485.32ZM938.11,485.34c0-250.08-202.73-452.8-452.8-452.8S32.51,235.26,32.51,485.34s202.73,452.8,452.8,452.8,452.8-202.73,452.8-452.8Z"/><path fill="currentColor" d="M892.79,485.25c0,225.05-182.44,407.49-407.49,407.49S77.82,710.3,77.82,485.25,260.26,77.77,485.31,77.77s407.49,182.44,407.49,407.49ZM470.27,112.09v335.5c0,1.05,13.11,12.99,15.36,14.43,1.65-2.06,14.64-13.4,14.64-14.43V112.59c0-1.1-2.44-1.43-3.45-1.55-8.42-.99-18.1.83-26.55,1.05ZM858.27,438.09c-20.14-166.94-158.46-303.59-325-324v324h325ZM437.27,115.09c-21.65,1.62-44.22,7.07-65,13.5-137.62,42.61-242.41,165.92-260,309.5h325V115.09ZM109.27,500.09h338.5c1,0,12.36-12.44,13.54-14.5,0-1-12.54-14.5-13.54-14.5H109.27c-1.81,9.94-.24,19.09,0,29ZM861.27,471.09h-338.5c-1,0-13.53,13.5-13.54,14.5.52,2.76,3.61,3.57,5.57,5.47,1.64,1.59,7.37,9.03,7.97,9.03h338.5c.9-9.78.9-19.22,0-29ZM500.27,860.09v-336.5c0-1.03-12.98-12.37-14.64-14.43-2.26,1.44-15.36,13.37-15.36,14.43v336.5h30ZM437.27,533.09H112.27c19.95,166.03,159.46,303.1,325,323v-323ZM858.27,533.09h-325v324c165.97-22.51,304.48-156.63,325-324Z"/><path fill="var(--accent)" d="M858.27,438.09h-325V114.09c166.54,20.41,304.86,157.06,325,324Z"/><path fill="var(--accent)" d="M858.27,533.09c-20.52,167.37-159.03,301.49-325,324v-324h325Z"/><path fill="var(--accent)" d="M437.27,533.09v323c-165.54-19.9-305.05-156.97-325-323h325Z"/><path fill="var(--accent)" d="M437.27,115.09v323H112.27c17.6-143.57,122.38-266.89,260-309.5,20.78-6.43,43.34-11.88,65-13.5ZM324.93,239.42c-5.22-5.22-14.48-5.8-20.62-1.79-23.51,27.2-56.28,50.77-79.07,77.93-3.21,3.83-6.62,7.81-7,13.05-.97,13.35,13.8,21.88,24.98,14.93,28.09-28.84,58.16-56.14,84.78-86.22,2.71-5.58,1.25-13.58-3.07-17.9ZM375.06,280.3c-4.15.41-7.65,2.76-10.8,5.27-2.42,1.93-17.06,17.64-18.19,19.81-7.64,14.76,7.17,29.85,21.55,22.56,2.83-1.44,19.3-18.18,21.64-21.36,8.21-11.17-.52-27.62-14.2-26.28ZM310.03,344.3c-2.88.42-6.45,2.49-8.78,4.26-4.52,3.45-32.55,31.28-34.83,35.17-8.84,15.07,8.47,31.23,23.59,21.59,4.35-2.77,34.16-32.7,36.28-36.72,6.36-12.04-2.95-26.26-16.27-24.31Z"/><path fill="var(--card)" d="M500.27,860.09h-30v-336.5c0-1.05,13.11-12.99,15.36-14.43,1.65,2.06,14.64,13.4,14.64,14.43v336.5Z"/><path fill="var(--card)" d="M470.27,112.09c8.45-.22,18.13-2.04,26.55-1.05,1.01.12,3.45.46,3.45,1.55v335c0,1.03-12.98,12.37-14.64,14.43-2.26-1.44-15.36-13.37-15.36-14.43V112.09Z"/><path fill="var(--card)" d="M109.27,500.09c-.24-9.91-1.81-19.06,0-29h338.5c1,0,13.54,13.5,13.54,14.5-1.17,2.06-12.54,14.5-13.54,14.5H109.27Z"/><path fill="var(--card)" d="M861.27,471.09c.9,9.78.9,19.22,0,29h-338.5c-.6,0-6.34-7.44-7.97-9.03-1.96-1.9-5.04-2.72-5.57-5.47,0-1,12.54-14.5,13.54-14.5h338.5Z"/><path fill="currentColor" d="M324.93,239.42c4.32,4.32,5.78,12.32,3.07,17.9-26.62,30.07-56.7,57.37-84.78,86.22-11.18,6.94-25.95-1.58-24.98-14.93.38-5.24,3.79-9.22,7-13.05,22.8-27.16,55.56-50.73,79.07-77.93,6.13-4.01,15.39-3.43,20.62,1.79Z"/><path fill="currentColor" d="M310.03,344.3c13.33-1.95,22.63,12.27,16.27,24.31-2.12,4.02-31.93,33.94-36.28,36.72-15.12,9.64-32.44-6.52-23.59-21.59,2.28-3.89,30.31-31.72,34.83-35.17,2.33-1.78,5.9-3.84,8.78-4.26Z"/><path fill="currentColor" d="M375.06,280.3c13.69-1.35,22.42,15.11,14.2,26.28-2.34,3.18-18.81,19.93-21.64,21.36-14.39,7.3-29.19-7.8-21.55-22.56,1.13-2.18,15.76-17.88,18.19-19.81,3.16-2.51,6.65-4.86,10.8-5.27Z"/></svg>
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
