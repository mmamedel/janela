// The janela frontend API — `import { invoke, listen } from "janela/api"`.
//
// janela injects a bridge as `window.janela` into every document before it
// loads, so this module is a thin wrapper over that global rather than a
// transport of its own. Importing it is the recommended style: bundlers
// resolve it, editors complete it, and `tsc` checks it. The global stays
// available unchanged for pages with no build step.

function bridge() {
  const found = typeof globalThis === "undefined" ? undefined : globalThis.janela;
  if (!found || typeof found.invoke !== "function") {
    throw new Error(
      "janela: no host bridge on this page (window.janela is undefined). " +
        "The page is not running inside a janela window — run the app with " +
        "`janela dev`, or `janela build` and launch the binary. Opening the " +
        "page in a browser, or serving it with plain `vite`, leaves no host " +
        "to talk to.",
    );
  }
  return found;
}

/**
 * Call a command the host registered with `app.command` / `app.commandAsync`.
 * Arguments and the resolved value are ordinary values; janela owns the
 * serialisation at the boundary.
 */
export async function invoke(cmd, args) {
  return bridge().invoke(cmd, args);
}

/**
 * Subscribe to an event the host sends with `app.emit`. Returns a function
 * that removes the subscription.
 */
export function listen(event, cb) {
  const off = bridge().listen(event, cb);
  // Hosts before 0.5.0 returned nothing from listen; keep a working disposer
  // either way rather than handing back undefined.
  if (typeof off === "function") return off;
  return function unlisten() {
    const all = globalThis.__wvListeners ? globalThis.__wvListeners[event] : undefined;
    if (!all) return;
    const i = all.indexOf(cb);
    if (i >= 0) all.splice(i, 1);
  };
}

/**
 * A client bound to a host's declared contract. The type parameter carries the
 * command and event tables; at runtime this is the same bridge as `invoke` and
 * `listen`, so the contract costs nothing and validates nothing — it is
 * checked entirely by the compiler.
 */
export function createClient() {
  return {
    invoke(name, args) {
      return invoke(name, args);
    },
    on(event, cb) {
      return listen(event, cb);
    },
  };
}
