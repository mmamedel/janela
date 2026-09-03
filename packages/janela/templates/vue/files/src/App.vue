<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { createClient } from "janela/api";
// A type-only import of the host's contract. It is erased at compile time, so
// no host code is bundled into the page — this is purely a type edge.
import type { App } from "../src-host/main";

const client = createClient<App>();

const greeting = ref("booting…");
const a = ref(2);
const b = ref(40);
const sum = ref("—");
const waited = ref("—");
const waiting = ref(false);
const events = ref<string[]>([]);
const path = ref("janela.conf.json");
const title = ref("__NAME__ — renamed");
const fileOut = ref("—");

// The event name is checked against the contract and `value` is inferred.
// `on` returns a disposer.
const off = client.on("added", (value) => events.value.unshift(`host emitted 'added': ${value}`));
onUnmounted(off);

onMounted(async () => {
  greeting.value = await client.invoke("greet", { name: "__NAME__" });
  await client.invoke("log", "page loaded");
});

async function add() {
  const [x, y] = [Number(a.value), Number(b.value)];
  sum.value = `add(${x}, ${y}) → ${await client.invoke("add", { a: x, b: y })}`;
}

async function wait() {
  waiting.value = true;
  waited.value = "waiting… try add, it still answers";
  waited.value = await client.invoke("wait", { ms: 2000 });
  waiting.value = false;
}

async function read() {
  const r = await client.invoke("readFile", { path: path.value });
  fileOut.value = r.ok ? `${path.value} — ${r.length} chars\n\n${r.text.slice(0, 400)}` : `error: ${r.error}`;
}

// The native open dialog. The window keeps serving other commands while the
// user is deciding.
async function pick() {
  const r = await client.invoke("openFile");
  if (!r.ok) fileOut.value = `error: ${r.error}`;
  else if (r.cancelled) fileOut.value = "cancelled";
  else fileOut.value = `${r.path} — ${r.length} chars\n\n${r.text.slice(0, 400)}`;
}
</script>

<template>
  <main>
    <header>
      <div class="mark" aria-hidden="true">
        <div class="bar"><i /><i /><i /></div>
        <div class="pane" />
      </div>
      <h1>__NAME__</h1>
      <p class="sub">TypeScript, compiled to a native binary. No Rust, no Node, no Electron.</p>
    </header>

    <p class="greeting">{{ greeting }}</p>

    <div class="grid">
      <section class="card">
        <h2>Typed commands</h2>
        <p class="why">
          The name, the arguments and the result are all checked at compile time — no codegen,
          because both sides are TypeScript.
        </p>
        <div class="row">
          <input v-model="a" type="number" aria-label="first number" />
          <span aria-hidden="true">+</span>
          <input v-model="b" type="number" aria-label="second number" />
          <button class="primary" @click="add">add</button>
        </div>
        <p class="result" :class="{ filled: sum !== '—' }">{{ sum }}</p>
        <h3>Events from the host</h3>
        <ul class="events">
          <li v-for="(e, i) in events" :key="i">{{ e }}</li>
        </ul>
      </section>

      <section class="card">
        <h2>Async without blocking</h2>
        <p class="why">
          The window keeps answering while this is pending: the dot keeps moving and
          <strong>add</strong> still works.
        </p>
        <div class="row">
          <button :disabled="waiting" @click="wait">wait 2s</button>
          <span v-if="waiting"><span class="pulse" /></span>
        </div>
        <p class="result" :class="{ filled: waited !== '—' }">{{ waited }}</p>
      </section>

      <section class="card wide">
        <h2>Files and the window</h2>
        <p class="why">
          Reads run on a worker thread, so a large file never freezes the window. The dialog is
          the real native one.
        </p>
        <div class="row">
          <input v-model="path" class="grow" type="text" aria-label="file to read" />
          <button @click="read">read</button>
          <button @click="pick">pick a file…</button>
          <input v-model="title" class="grow" type="text" aria-label="window title" />
          <button @click="client.invoke('setTitle', { title })">set title</button>
        </div>
        <pre class="result" :class="{ filled: fileOut !== '—' }">{{ fileOut }}</pre>
      </section>
    </div>

    <footer>
      <span>Edit <code>src/App.vue</code> for the page and <code>src-host/main.ts</code> for the commands.</span>
      <button @click="client.invoke('quit')">Quit</button>
    </footer>
  </main>
</template>
