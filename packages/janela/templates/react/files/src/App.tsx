import { useEffect, useRef, useState } from "react";
import { createClient } from "janela/api";
// A type-only import of the host's contract. It is erased at compile time, so
// no host code is bundled into the page — this is purely a type edge.
import type { App as HostApp } from "../src-host/main";

const client = createClient<HostApp>();

export default function App() {
  const [greeting, setGreeting] = useState("booting…");
  const [a, setA] = useState(2);
  const [b, setB] = useState(40);
  const [sum, setSum] = useState("—");
  const [waited, setWaited] = useState("—");
  const [waiting, setWaiting] = useState(false);
  const [events, setEvents] = useState<string[]>([]);
  const [path, setPath] = useState("janela.conf.json");
  const [title, setTitle] = useState("__NAME__ — renamed");
  const [fileOut, setFileOut] = useState("—");

  // StrictMode mounts effects twice in development; the guard keeps the
  // greeting from being fetched (and the listener registered) twice.
  const started = useRef(false);

  useEffect(() => {
    // The event name is checked against the contract and `value` is inferred.
    // `on` returns a disposer.
    const off = client.on("added", (value) =>
      setEvents((prev) => [`host emitted 'added': ${value}`, ...prev]),
    );
    if (!started.current) {
      started.current = true;
      client.invoke("greet", { name: "__NAME__" }).then(setGreeting);
      client.invoke("log", "page loaded");
    }
    return off;
  }, []);

  async function add() {
    setSum(`add(${a}, ${b}) → ${await client.invoke("add", { a, b })}`);
  }

  async function wait() {
    setWaiting(true);
    setWaited("waiting… try add, it still answers");
    setWaited(await client.invoke("wait", { ms: 2000 }));
    setWaiting(false);
  }

  async function read() {
    const r = await client.invoke("readFile", { path });
    setFileOut(r.ok ? `${path} — ${r.length} chars\n\n${r.text.slice(0, 400)}` : `error: ${r.error}`);
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
        <div className="mark" aria-hidden="true">
          <div className="bar">
            <i />
            <i />
            <i />
          </div>
          <div className="pane" />
        </div>
        <h1>__NAME__</h1>
        <p className="sub">TypeScript, compiled to a native binary. No Rust, no Node, no Electron.</p>
      </header>

      <p className="greeting">{greeting}</p>

      <div className="grid">
        <section className="card">
          <h2>Typed commands</h2>
          <p className="why">
            The name, the arguments and the result are all checked at compile time — no codegen,
            because both sides are TypeScript.
          </p>
          <div className="row">
            <input
              type="number"
              value={a}
              aria-label="first number"
              onChange={(e) => setA(Number(e.target.value))}
            />
            <span aria-hidden="true">+</span>
            <input
              type="number"
              value={b}
              aria-label="second number"
              onChange={(e) => setB(Number(e.target.value))}
            />
            <button className="primary" onClick={add}>
              add
            </button>
          </div>
          <p className={sum === "—" ? "result" : "result filled"}>{sum}</p>
          <h3>Events from the host</h3>
          <ul className="events">
            {events.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </section>

        <section className="card">
          <h2>Async without blocking</h2>
          <p className="why">
            The window keeps answering while this is pending: the dot keeps moving and{" "}
            <strong>add</strong> still works.
          </p>
          <div className="row">
            <button disabled={waiting} onClick={wait}>
              wait 2s
            </button>
            {waiting && (
              <span>
                <span className="pulse" />
              </span>
            )}
          </div>
          <p className={waited === "—" ? "result" : "result filled"}>{waited}</p>
        </section>

        <section className="card wide">
          <h2>Files and the window</h2>
          <p className="why">
            Reads run on a worker thread, so a large file never freezes the window. The dialog is
            the real native one.
          </p>
          <div className="row">
            <input
              className="grow"
              type="text"
              value={path}
              aria-label="file to read"
              onChange={(e) => setPath(e.target.value)}
            />
            <button onClick={read}>read</button>
            <button onClick={pick}>pick a file…</button>
            <input
              className="grow"
              type="text"
              value={title}
              aria-label="window title"
              onChange={(e) => setTitle(e.target.value)}
            />
            <button onClick={() => client.invoke("setTitle", { title })}>set title</button>
          </div>
          <pre className={fileOut === "—" ? "result" : "result filled"}>{fileOut}</pre>
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
