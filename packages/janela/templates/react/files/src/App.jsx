import { useEffect, useState } from "react";
import "./App.css";

export default function App() {
  const [greeting, setGreeting] = useState("…");
  const [a, setA] = useState(2);
  const [b, setB] = useState(40);
  const [sum, setSum] = useState(null);
  const [events, setEvents] = useState([]);

  useEffect(() => {
    // Backend→frontend events. The payload arrives as a value.
    janela.listen("added", (value) =>
      setEvents((prev) => [`host emitted: ${value}`, ...prev]),
    );
    janela.invoke("greet", { name: "__NAME__" }).then(setGreeting);
  }, []);

  const add = async () =>
    setSum(await janela.invoke("add", { a: Number(a), b: Number(b) }));

  return (
    <>
      <h1>{greeting}</h1>
      <p>
        <input type="number" value={a} onChange={(e) => setA(e.target.value)} /> +
        <input type="number" value={b} onChange={(e) => setB(e.target.value)} />
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
