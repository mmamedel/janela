<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { createClient } from "janela/api";
// A type-only import of the host's contract. It is erased at compile time, so
// no host code is bundled into the page — this is purely a type edge.
import type { App } from "../src-host/main";

const client = createClient<App>();

const greeting = ref("…");
const a = ref(2);
const b = ref(40);
const sum = ref<number | null>(null);
const events = ref<string[]>([]);

// The event name is checked against the contract and `value` is inferred.
// `on` returns a disposer.
const off = client.on("added", (value) => events.value.unshift(`host emitted: ${value}`));
onUnmounted(off);

onMounted(async () => {
  greeting.value = await client.invoke("greet", { name: "__NAME__" });
});

async function add() {
  sum.value = await client.invoke("add", { a: Number(a.value), b: Number(b.value) });
}
</script>

<template>
  <h1>{{ greeting }}</h1>
  <p>
    <input v-model="a" type="number" /> +
    <input v-model="b" type="number" />
    <button @click="add">add</button>
    <span v-if="sum !== null"> = {{ sum }}</span>
  </p>
  <ul>
    <li v-for="(e, i) in events" :key="i">{{ e }}</li>
  </ul>
</template>

<style>
body { font: 16px -apple-system, system-ui, sans-serif; padding: 2rem; }
input { width: 5em; }
ul { color: #666; font-size: 13px; }
</style>
