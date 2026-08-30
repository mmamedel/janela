import { createSignal, onMount, For, Show } from "solid-js";
import { invoke, listen } from "janela/api";
import "./App.css";

export default function App() {
  const [greeting, setGreeting] = createSignal("…");
  const [a, setA] = createSignal(2);
  const [b, setB] = createSignal(40);
  const [sum, setSum] = createSignal<number | null>(null);
  const [events, setEvents] = createSignal<string[]>([]);

  // Backend→frontend events. The payload arrives as a value, and the generic
  // says which value.
  listen<number>("added", (value) =>
    setEvents((prev) => [`host emitted: ${value}`, ...prev]),
  );

  onMount(async () =>
    setGreeting(await invoke<string>("greet", { name: "__NAME__" })),
  );

  const add = async () =>
    setSum(await invoke<number>("add", { a: a(), b: b() }));

  return (
    <>
      <h1>{greeting()}</h1>
      <p>
        <input
          type="number"
          value={a()}
          onInput={(e) => setA(Number(e.currentTarget.value))}
        />{" "}
        +
        <input
          type="number"
          value={b()}
          onInput={(e) => setB(Number(e.currentTarget.value))}
        />
        <button onClick={add}>add</button>
        <Show when={sum() !== null}>
          <span> = {sum()}</span>
        </Show>
      </p>
      <ul>
        <For each={events()}>{(e) => <li>{e}</li>}</For>
      </ul>
    </>
  );
}
