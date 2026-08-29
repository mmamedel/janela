import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// janela flattens this build into one HTML document at `janela build` time,
// so there is no server and no base path to configure.
export default defineConfig({ plugins: [svelte()] });
