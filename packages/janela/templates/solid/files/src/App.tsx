import { createSignal, onCleanup, onMount, For, Show } from "solid-js";
import { createClient } from "janela/api";
// Type-only import of the host contract: erased at compile time, so no host
// code is bundled into the page.
import type { App as Contract } from "../src-host/main";

const client = createClient<Contract>();

export default function App() {
  const [greeting, setGreeting] = createSignal("booting…");
  const [a, setA] = createSignal(2);
  const [b, setB] = createSignal(40);
  const [sum, setSum] = createSignal("—");
  const [waited, setWaited] = createSignal("—");
  const [waiting, setWaiting] = createSignal(false);
  const [events, setEvents] = createSignal<string[]>([]);
  const [path, setPath] = createSignal("janela.conf.json");
  const [title, setTitle] = createSignal("__NAME__ — renamed");
  const [fileOut, setFileOut] = createSignal("—");

  // Backend→frontend events. The payload arrives as a value, and the generic
  // says which value. `on` returns a disposer.
  onCleanup(
    client.on("added", (value) => setEvents((prev) => [`host emitted 'added': ${value}`, ...prev])),
  );

  onMount(async () => {
    setGreeting(await client.invoke("greet", { name: "__NAME__" }));
    await client.invoke("log", "page loaded");
  });

  async function add() {
    const [x, y] = [a(), b()];
    setSum(`add(${x}, ${y}) → ${await client.invoke("add", { a: x, b: y })}`);
  }

  async function wait() {
    setWaiting(true);
    setWaited("waiting… try add, it still answers");
    setWaited(await client.invoke("wait", { ms: 2000 }));
    setWaiting(false);
  }

  async function read() {
    const p = path();
    const r = await client.invoke("readFile", { path: p });
    setFileOut(r.ok ? `${p} — ${r.length} chars\n\n${r.text.slice(0, 400)}` : `error: ${r.error}`);
  }

  // The native open dialog. The window keeps serving other commands while the
  // user is deciding.
  async function pick() {
    const r = await client.invoke("openFile");
    if (!r.ok) setFileOut(`error: ${r.error}`);
    else if (r.cancelled) setFileOut("cancelled");
    else setFileOut(`${r.path} — ${r.length} chars\n\n${r.text.slice(0, 400)}`);
  }

  return (
    <main>
      <header>
        <div class="mark" aria-hidden="true">
          <div class="bar">
            <i />
            <i />
            <i />
          </div>
          <div class="pane" />
        </div>
        <h1>__NAME__</h1>
        <p class="sub">TypeScript, compiled to a native binary. No Rust, no Node, no Electron.</p>
      </header>

      <p class="greeting">{greeting()}</p>

      <div class="grid">
        <section class="card">
          <h2>Typed commands</h2>
          <p class="why">
            The name, the arguments and the result are all checked at compile time — no codegen,
            because both sides are TypeScript.
          </p>
          <div class="row">
            <input
              type="number"
              value={a()}
              aria-label="first number"
              onInput={(e) => setA(Number(e.currentTarget.value))}
            />
            <span aria-hidden="true">+</span>
            <input
              type="number"
              value={b()}
              aria-label="second number"
              onInput={(e) => setB(Number(e.currentTarget.value))}
            />
            <button class="primary" onClick={add}>
              add
            </button>
          </div>
          <p class={sum() === "—" ? "result" : "result filled"}>{sum()}</p>
          <h3>Events from the host</h3>
          <ul class="events">
            <For each={events()}>{(e) => <li>{e}</li>}</For>
          </ul>
        </section>

        <section class="card">
          <h2>Async without blocking</h2>
          <p class="why">
            The window keeps answering while this is pending: the dot keeps moving and{" "}
            <strong>add</strong> still works.
          </p>
          <div class="row">
            <button disabled={waiting()} onClick={wait}>
              wait 2s
            </button>
            <Show when={waiting()}>
              <span>
                <span class="pulse" />
              </span>
            </Show>
          </div>
          <p class={waited() === "—" ? "result" : "result filled"}>{waited()}</p>
        </section>

        <section class="card wide">
          <h2>Files and the window</h2>
          <p class="why">
            Reads run on a worker thread, so a large file never freezes the window. The dialog is
            the real native one.
          </p>
          <div class="row">
            <input
              class="grow"
              type="text"
              value={path()}
              aria-label="file to read"
              onInput={(e) => setPath(e.currentTarget.value)}
            />
            <button onClick={read}>read</button>
            <button onClick={pick}>pick a file…</button>
            <input
              class="grow"
              type="text"
              value={title()}
              aria-label="window title"
              onInput={(e) => setTitle(e.currentTarget.value)}
            />
            <button onClick={() => client.invoke("setTitle", { title: title() })}>set title</button>
          </div>
          <pre class={fileOut() === "—" ? "result" : "result filled"}>{fileOut()}</pre>
        </section>
      </div>

      <footer>
        <span>
          Edit <code>src/App.tsx</code> for the page and <code>src-host/main.ts</code> for the
          commands.
        </span>
        <button onClick={() => client.invoke("quit")}>Quit</button>
      </footer>
    </main>
  );
}
