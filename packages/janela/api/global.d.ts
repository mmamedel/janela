/**
 * Types for the injected `janela` global, for pages that use it directly
 * rather than importing `janela/api` — a plain `<script>` with no bundler,
 * typically. Pull them in from a TypeScript project with:
 *
 * ```ts
 * /// <reference types="janela/global" />
 * ```
 *
 * or by adding `"janela/global"` to `compilerOptions.types` in tsconfig.json.
 *
 * If you have a bundler, prefer `import { invoke, listen } from "janela/api"` —
 * it needs no ambient declaration and is what the templates use.
 */

import type { JanelaBridge } from "./index.js";

declare global {
  /** The host bridge janela injects before the document loads. */
  const janela: JanelaBridge;

  interface Window {
    janela: JanelaBridge;
  }
}

export {};
