import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

// janela flattens this build into one HTML document at `janela build` time,
// so there is no server and no base path to configure.
export default defineConfig({ plugins: [solid()] });
