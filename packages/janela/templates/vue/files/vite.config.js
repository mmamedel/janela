import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

// janela flattens this build into one HTML document at `janela build` time,
// so there is no server and no base path to configure.
export default defineConfig({ plugins: [vue()] });
