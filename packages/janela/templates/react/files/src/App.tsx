import { useEffect, useState } from "react";
import { invoke, listen } from "janela/api";
import "./App.css";

export default function App() {
  const [greeting, setGreeting] = useState("…");
  const [a, setA] = useState(2);
  const [b, setB] = useState(40);
  const [sum, setSum] = useState<number | null>(null);
  const [events, setEvents] = useState<string[]>([]);

  useEffect(() => {
    // Backend→frontend events. The payload arrives as a value, and the
    // generic says which value.
    listen<number>("added", (value) =>
      setEvents((prev) => [`host emitted: ${value}`, ...prev]),
    );
    invoke<string>("greet", { name: "__NAME__" }).then(setGreeting);
  }, []);

  const add = async () =>
    setSum(await invoke<number>("add", { a, b }));

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
