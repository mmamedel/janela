import { createSignal, onMount, For, Show } from "solid-js";
import "./App.css";

export default function App() {
  const [greeting, setGreeting] = createSignal("…");
  const [a, setA] = createSignal(2);
  const [b, setB] = createSignal(40);
  const [sum, setSum] = createSignal(null);
  const [events, setEvents] = createSignal([]);

  // Backend→frontend events. The payload arrives as a value.
  janela.listen("added", (value) =>
    setEvents((prev) => [`host emitted: ${value}`, ...prev]),
  );

  onMount(async () => setGreeting(await janela.invoke("greet", { name: "__NAME__" })));

  const add = async () =>
    setSum(await janela.invoke("add", { a: Number(a()), b: Number(b()) }));

  return (
    <>
      <h1>{greeting()}</h1>
      <p>
        <input type="number" value={a()} onInput={(e) => setA(e.currentTarget.value)} /> +
        <input type="number" value={b()} onInput={(e) => setB(e.currentTarget.value)} />
        <button onClick={add}>add</button>
        <Show when={sum() !== null}><span> = {sum()}</span></Show>
      </p>
      <ul>
        <For each={events()}>{(e) => <li>{e}</li>}</For>
      </ul>
    </>
  );
}
