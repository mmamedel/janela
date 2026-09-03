<script setup lang="ts">
import { onMounted, ref } from "vue";
import { createClient } from "janela/api";
// A type-only import of the host's contract: command names, argument shapes
// and results are checked against it, with no code generation, because both
// sides are TypeScript and this import erases at compile time.
import type { App } from "../src-host/main";

const client = createClient<App>();

const name = ref("");
const greeting = ref("");

// `greet` is a command in src-host/main.ts, compiled to machine code.
async function greet() {
  greeting.value = await client.invoke("greet", { name: name.value || "__NAME__" });
}

// Greeted once on load, so the round trip is visible without a click.
onMounted(async () => {
  await greet();
  await client.invoke("log", "page loaded");
});
</script>

<template>
  <main class="container">
    <h1>Welcome to janela + Vue</h1>
    <p class="hint">TypeScript, compiled to a native binary. No Rust, no Node, no Electron.</p>

    <div class="row logos">
        <a href="https://vite.dev" target="_blank" rel="noreferrer"><svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true" role="img" class="iconify iconify--logos logo vite" preserveAspectRatio="xMidYMid meet" viewBox="0 0 256 257"><defs><linearGradient id="IconifyId1813088fe1fbc01fb466" x1="-.828%" x2="57.636%" y1="7.652%" y2="78.411%"><stop offset="0%" stop-color="#41D1FF"></stop><stop offset="100%" stop-color="#BD34FE"></stop></linearGradient><linearGradient id="IconifyId1813088fe1fbc01fb467" x1="43.376%" x2="50.316%" y1="2.242%" y2="89.03%"><stop offset="0%" stop-color="#FFEA83"></stop><stop offset="8.333%" stop-color="#FFDD35"></stop><stop offset="100%" stop-color="#FFA800"></stop></linearGradient></defs><path fill="url(#IconifyId1813088fe1fbc01fb466)" d="M255.153 37.938L134.897 252.976c-2.483 4.44-8.862 4.466-11.382.048L.875 37.958c-2.746-4.814 1.371-10.646 6.827-9.67l120.385 21.517a6.537 6.537 0 0 0 2.322-.004l117.867-21.483c5.438-.991 9.574 4.796 6.877 9.62Z"></path><path fill="url(#IconifyId1813088fe1fbc01fb467)" d="M185.432.063L96.44 17.501a3.268 3.268 0 0 0-2.634 3.014l-5.474 92.456a3.268 3.268 0 0 0 3.997 3.378l24.777-5.718c2.318-.535 4.413 1.507 3.936 3.838l-7.361 36.047c-.495 2.426 1.782 4.5 4.151 3.78l15.304-4.649c2.372-.72 4.652 1.36 4.15 3.788l-11.698 56.621c-.732 3.542 3.979 5.473 5.943 2.437l1.313-2.028l72.516-144.72c1.215-2.423-.88-5.186-3.54-4.672l-25.505 4.922c-2.396.462-4.435-1.77-3.759-4.114l16.646-57.705c.677-2.35-1.37-4.583-3.769-4.113Z"></path></svg></a>
        <a href="https://mmamedel.github.io/janela/" target="_blank" rel="noreferrer"><svg class="logo janela" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 970.64 970.64" role="img" aria-label="janela"><path fill="currentColor" d="M970.64,485.32c0,268.03-217.28,485.32-485.32,485.32S0,753.35,0,485.32,217.28,0,485.32,0s485.32,217.28,485.32,485.32ZM938.11,485.34c0-250.08-202.73-452.8-452.8-452.8S32.51,235.26,32.51,485.34s202.73,452.8,452.8,452.8,452.8-202.73,452.8-452.8Z"/><path fill="currentColor" d="M892.79,485.25c0,225.05-182.44,407.49-407.49,407.49S77.82,710.3,77.82,485.25,260.26,77.77,485.31,77.77s407.49,182.44,407.49,407.49ZM470.27,112.09v335.5c0,1.05,13.11,12.99,15.36,14.43,1.65-2.06,14.64-13.4,14.64-14.43V112.59c0-1.1-2.44-1.43-3.45-1.55-8.42-.99-18.1.83-26.55,1.05ZM858.27,438.09c-20.14-166.94-158.46-303.59-325-324v324h325ZM437.27,115.09c-21.65,1.62-44.22,7.07-65,13.5-137.62,42.61-242.41,165.92-260,309.5h325V115.09ZM109.27,500.09h338.5c1,0,12.36-12.44,13.54-14.5,0-1-12.54-14.5-13.54-14.5H109.27c-1.81,9.94-.24,19.09,0,29ZM861.27,471.09h-338.5c-1,0-13.53,13.5-13.54,14.5.52,2.76,3.61,3.57,5.57,5.47,1.64,1.59,7.37,9.03,7.97,9.03h338.5c.9-9.78.9-19.22,0-29ZM500.27,860.09v-336.5c0-1.03-12.98-12.37-14.64-14.43-2.26,1.44-15.36,13.37-15.36,14.43v336.5h30ZM437.27,533.09H112.27c19.95,166.03,159.46,303.1,325,323v-323ZM858.27,533.09h-325v324c165.97-22.51,304.48-156.63,325-324Z"/><path fill="var(--accent, #1c6fd4)" d="M858.27,438.09h-325V114.09c166.54,20.41,304.86,157.06,325,324Z"/><path fill="var(--accent, #1c6fd4)" d="M858.27,533.09c-20.52,167.37-159.03,301.49-325,324v-324h325Z"/><path fill="var(--accent, #1c6fd4)" d="M437.27,533.09v323c-165.54-19.9-305.05-156.97-325-323h325Z"/><path fill="var(--accent, #1c6fd4)" d="M437.27,115.09v323H112.27c17.6-143.57,122.38-266.89,260-309.5,20.78-6.43,43.34-11.88,65-13.5ZM324.93,239.42c-5.22-5.22-14.48-5.8-20.62-1.79-23.51,27.2-56.28,50.77-79.07,77.93-3.21,3.83-6.62,7.81-7,13.05-.97,13.35,13.8,21.88,24.98,14.93,28.09-28.84,58.16-56.14,84.78-86.22,2.71-5.58,1.25-13.58-3.07-17.9ZM375.06,280.3c-4.15.41-7.65,2.76-10.8,5.27-2.42,1.93-17.06,17.64-18.19,19.81-7.64,14.76,7.17,29.85,21.55,22.56,2.83-1.44,19.3-18.18,21.64-21.36,8.21-11.17-.52-27.62-14.2-26.28ZM310.03,344.3c-2.88.42-6.45,2.49-8.78,4.26-4.52,3.45-32.55,31.28-34.83,35.17-8.84,15.07,8.47,31.23,23.59,21.59,4.35-2.77,34.16-32.7,36.28-36.72,6.36-12.04-2.95-26.26-16.27-24.31Z"/><path fill="var(--card, var(--bg, #f6f6f7))" d="M500.27,860.09h-30v-336.5c0-1.05,13.11-12.99,15.36-14.43,1.65,2.06,14.64,13.4,14.64,14.43v336.5Z"/><path fill="var(--card, var(--bg, #f6f6f7))" d="M470.27,112.09c8.45-.22,18.13-2.04,26.55-1.05,1.01.12,3.45.46,3.45,1.55v335c0,1.03-12.98,12.37-14.64,14.43-2.26-1.44-15.36-13.37-15.36-14.43V112.09Z"/><path fill="var(--card, var(--bg, #f6f6f7))" d="M109.27,500.09c-.24-9.91-1.81-19.06,0-29h338.5c1,0,13.54,13.5,13.54,14.5-1.17,2.06-12.54,14.5-13.54,14.5H109.27Z"/><path fill="var(--card, var(--bg, #f6f6f7))" d="M861.27,471.09c.9,9.78.9,19.22,0,29h-338.5c-.6,0-6.34-7.44-7.97-9.03-1.96-1.9-5.04-2.72-5.57-5.47,0-1,12.54-14.5,13.54-14.5h338.5Z"/><path fill="currentColor" d="M324.93,239.42c4.32,4.32,5.78,12.32,3.07,17.9-26.62,30.07-56.7,57.37-84.78,86.22-11.18,6.94-25.95-1.58-24.98-14.93.38-5.24,3.79-9.22,7-13.05,22.8-27.16,55.56-50.73,79.07-77.93,6.13-4.01,15.39-3.43,20.62,1.79Z"/><path fill="currentColor" d="M310.03,344.3c13.33-1.95,22.63,12.27,16.27,24.31-2.12,4.02-31.93,33.94-36.28,36.72-15.12,9.64-32.44-6.52-23.59-21.59,2.28-3.89,30.31-31.72,34.83-35.17,2.33-1.78,5.9-3.84,8.78-4.26Z"/><path fill="currentColor" d="M375.06,280.3c13.69-1.35,22.42,15.11,14.2,26.28-2.34,3.18-18.81,19.93-21.64,21.36-14.39,7.3-29.19-7.8-21.55-22.56,1.13-2.18,15.76-17.88,18.19-19.81,3.16-2.51,6.65-4.86,10.8-5.27Z"/></svg></a>
        <a href="https://vuejs.org" target="_blank" rel="noreferrer"><svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true" role="img" class="iconify iconify--logos logo vue" preserveAspectRatio="xMidYMid meet" viewBox="0 0 256 198"><path fill="#41B883" d="M204.8 0H256L128 220.8L0 0h97.92L128 51.2L157.44 0h47.36Z"></path><path fill="#41B883" d="m0 0l128 220.8L256 0h-51.2L128 132.48L50.56 0H0Z"></path><path fill="#35495E" d="M50.56 0L128 133.12L204.8 0h-47.36L128 51.2L97.92 0H50.56Z"></path></svg></a>
      </div>
      <p class="hint">Click on the janela, Vite, and Vue logos to learn more.</p>

    <form class="row" @submit.prevent="greet">
      <input id="greet-input" v-model="name" placeholder="Enter a name..." aria-label="a name to greet" />
      <button type="submit">Greet</button>
    </form>
    <p class="greeting">{{ greeting }}</p>
  </main>
</template>
