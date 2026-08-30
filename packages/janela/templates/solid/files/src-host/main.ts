// src-host/main.ts — your app's backend, compiled to native code by scriptc.
//
// The contract below is the single declaration of what this app exposes. The
// frontend imports `App` with `import type`, so the page is checked against
// these exact types — command names, argument shapes, results and event
// payloads — with no code generation and nothing to keep in sync.
//
// Two gotchas inherited from scriptc:
//   - never use a bare FFI-backed call as a complete variable initializer;
//     wrap it in any expression (`+ 0`);
//   - write `args: null` for a command that takes nothing, not `undefined` —
//     an `undefined` argument lowers to a zero-parameter function and fails
//     to compile.

import {
  defineCommands,
  defineEvents,
  emit,
  on,
  onAsync,
  type JanelaApp,
} from "janela/host";

export const commands = defineCommands<{
  add: { args: { a: number; b: number }; result: number };
  greet: { args: { name: string }; result: string };
  log: { args: string; result: null };
  wait: { args: { ms: number }; result: string };
  quit: { args: null; result: null };
}>();

export const events = defineEvents<{
  added: number;
}>();

/** The contract the page imports with `import type { App } from "../src-host/main"`. */
export type App = { commands: typeof commands; events: typeof events };

export function setup(app: JanelaApp): void {
  // `args` is inferred from the contract, and the return type is checked
  // against it — no casts, and no way to drift from what the page expects.
  on(app, commands, "add", (args) => {
    const sum = args.a + args.b;
    emit(app, events, "added", sum);
    return sum;
  });

  on(app, commands, "greet", (args) => {
    return "Hello, " + args.name + " — from the native TS binary";
  });

  on(app, commands, "log", (args) => {
    console.log("[host] page says:", args);
    return null;
  });

  // An async command: answers later, without freezing the window.
  onAsync(app, commands, "wait", (args, resolve) => {
    app.sleep(args.ms, () => {
      resolve("waited " + args.ms + "ms without blocking the UI");
    });
  });

  on(app, commands, "quit", (_args) => {
    app.quit();
    return null;
  });
}
