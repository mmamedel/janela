<script setup lang="ts">
import { onMounted, ref } from "vue";
import { invoke, listen } from "janela/api";

const greeting = ref("…");
const a = ref(2);
const b = ref(40);
const sum = ref<number | null>(null);
const events = ref<string[]>([]);

// Backend→frontend events. The payload arrives as a value, not a JSON string,
// and the generic says which value.
listen<number>("added", (value) => events.value.unshift(`host emitted: ${value}`));

onMounted(async () => {
  greeting.value = await invoke<string>("greet", { name: "__NAME__" });
});

async function add() {
  sum.value = await invoke<number>("add", { a: Number(a.value), b: Number(b.value) });
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
