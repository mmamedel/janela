import { useEffect, useState } from "react";
import { createClient } from "janela/api";
// Type-only import of the host contract: erased at compile time, so no host
// code is bundled into the page.
import type { App as Contract } from "../src-host/main";
import "./App.css";

const client = createClient<Contract>();

export default function App() {
  const [greeting, setGreeting] = useState("…");
  const [a, setA] = useState(2);
  const [b, setB] = useState(40);
  const [sum, setSum] = useState<number | null>(null);
  const [events, setEvents] = useState<string[]>([]);

  useEffect(() => {
    // The event name is checked against the contract, `value` is inferred,
    // and `on` returns a disposer.
    const off = client.on("added", (value) =>
      setEvents((prev) => [`host emitted: ${value}`, ...prev]),
    );
    client.invoke("greet", { name: "__NAME__" }).then(setGreeting);
    return off;
  }, []);

  const add = async () =>
    setSum(await client.invoke("add", { a, b }));

  return (
    <>
      <h1>{greeting}</h1>
      <p>
        <input
          type="number"
          value={a}
          onChange={(e) => setA(Number(e.target.value))}
        />{" "}
        +
        <input
          type="number"
          value={b}
          onChange={(e) => setB(Number(e.target.value))}
        />
        <button onClick={add}>add</button>
        {sum !== null && <span> = {sum}</span>}
      </p>
      <ul>
        {events.map((e, i) => (
          <li key={i}>{e}</li>
        ))}
      </ul>
    </>
  );
}
