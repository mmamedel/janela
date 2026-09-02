// The end-to-end fixture's host side.
//
// This file replaces a scaffolded project's src-host/main.ts. It deliberately
// owns every command the battery needs instead of relying on whatever the
// template happens to ship: templates have changed shape several times, and a
// suite that depends on them fails for the wrong reason.
//
// The contract below is a SUPERSET of the one the framework templates declare
// (add / greet / log / wait / quit, plus the `added` event), so the template's
// own page still type-checks, renders and round-trips while the appended
// battery script drives the assertions.
//
// Gotcha inherited from scriptc: never use a bare FFI-backed call as a
// complete variable initializer — wrap it in any expression (`+ 0`).

import type { JanelaApp } from "janela/host";

export type AppCommands = {
  // --- what the framework templates' own pages call ---
  add: (args: { a: number; b: number }) => number;
  greet: (args: { name: string }) => string;
  log: (args: string) => void;
  wait: (args: { ms: number }) => string;
  quit: () => void;

  // --- the battery ---
  /** A cheap synchronous command, used to measure host responsiveness. */
  ping: (args: { seq: number }) => number;
  /** Registers sleeps out of due order and reports the order they fired in. */
  sleepOrder: () => string[];
  /** Reports whether defer() runs before a 50ms sleep. */
  deferOrder: () => string[];
  /** Always rejects, to prove a rejection reaches the page. */
  boom: () => string;
  /** Emits the `added` event with the given value. */
  emitNow: (args: { value: number }) => null;
  fsWrite: (args: { path: string; data: string }) => { ok: boolean; error: string | null };
  fsRead: (args: { path: string }) => {
    ok: boolean;
    error: string | null;
    text: string;
    length: number;
  };
  /** Reads a large file and reports how long the whole operation took. */
  bigRead: (args: { path: string }) => { ok: boolean; ms: number; length: number };
  /** Starts a long read and a long timer, then returns immediately. */
  startWork: (args: { path: string; runId: string }) => null;
};

export type AppEvents = {
  added: number;
};

export type App = JanelaApp<AppCommands, AppEvents>;

export function setup(app: App): void {
  // --- template-compatible commands ---

  app.command("add", (args) => {
    const sum = args.a + args.b;
    app.emit("added", sum);
    return sum;
  });

  app.command("greet", (args) => {
    return "Hello, " + args.name + " — from the native TS binary";
  });

  // The battery's transport: the page hands us a line, we print it verbatim so
  // the runner can parse it out of stdout / os_log / logcat identically.
  app.command("log", (args) => {
    console.log(args);
    return null;
  });

  app.commandAsync("wait", (args, resolve) => {
    app.sleep(args.ms, () => {
      resolve("waited " + args.ms + "ms without blocking the UI");
    });
  });

  app.command("quit", (_args) => {
    app.quit();
    return null;
  });

  // --- battery commands ---

  app.command("ping", (args) => {
    return args.seq;
  });

  // Registered 80, 20, 50 — a due-ordered queue must fire 20, 50, 80. A
  // fourth timer well after the others reports whatever order was observed,
  // so a FIFO regression is reported rather than resolving early with a
  // half-filled list.
  app.commandAsync("sleepOrder", (_args, resolve) => {
    const fired: string[] = [];
    app.sleep(80, () => {
      fired.push("s80");
    });
    app.sleep(20, () => {
      fired.push("s20");
    });
    app.sleep(50, () => {
      fired.push("s50");
    });
    app.sleep(300, () => {
      resolve(fired);
    });
  });

  app.commandAsync("deferOrder", (_args, resolve) => {
    const fired: string[] = [];
    app.defer(() => {
      fired.push("defer");
    });
    app.sleep(50, () => {
      fired.push("sleep50");
    });
    app.sleep(200, () => {
      resolve(fired);
    });
  });

  app.commandAsync("boom", (_args, _resolve, reject) => {
    reject("deliberate rejection");
  });

  app.command("emitNow", (args) => {
    app.emit("added", args.value);
    return null;
  });

  app.commandAsync("fsWrite", (args, resolve) => {
    app.writeFileAsync(args.path, args.data, (err) => {
      resolve({ ok: err === null, error: err });
    });
  });

  app.commandAsync("fsRead", (args, resolve) => {
    app.readFileAsync(args.path, (err, text) => {
      resolve({
        ok: err === null,
        error: err,
        text: err === null ? text : "",
        length: err === null ? text.length : 0,
      });
    });
  });

  app.commandAsync("bigRead", (args, resolve) => {
    const started = Date.now() + 0;
    app.readFileAsync(args.path, (err, text) => {
      resolve({
        ok: err === null,
        ms: Date.now() - started,
        length: err === null ? text.length : 0,
      });
    });
  });

  // For the clean-exit scenario: leave real work in flight, then let the page
  // quit immediately. Neither continuation should keep the process alive.
  app.command("startWork", (args) => {
    const tag = " " + args.runId;
    app.readFileAsync(args.path, (_err, _text) => {
      console.log("JANELA_TEST_LATE read-finished" + tag);
    });
    app.sleep(5000, () => {
      console.log("JANELA_TEST_LATE timer-finished" + tag);
    });
    return null;
  });
}
