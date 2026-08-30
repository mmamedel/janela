// SPIKE — the TypeScript side as a LIBRARY. No async surface anywhere
// (library mode forbids it, SC4005). The native shell owns main().
let invokes = 0;

/** One entry point: the whole IPC surface, JSON in / JSON out. */
export function handleInvoke(cmd: string, argsJson: string): string {
  invokes = invokes + 1;
  if (cmd === "add") {
    const a = JSON.parse(argsJson) as { a: number; b: number };
    return JSON.stringify(a.a + a.b);
  }
  if (cmd === "greet") {
    const a = JSON.parse(argsJson) as { name: string };
    return JSON.stringify("hello " + a.name + " — from a scriptc LIBRARY");
  }
  if (cmd === "stats") {
    return JSON.stringify({ invokes: invokes });
  }
  const unknownCmd: string | null = null;
  return JSON.stringify(unknownCmd);  // bare `null` literal ICEs the compiler (SC9001)
}
