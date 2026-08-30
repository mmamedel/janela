// SPIKE — the TypeScript side of an iOS janela app, compiled by scriptc to a
// static library for aarch64-apple-ios-simulator. No async surface anywhere:
// library mode forbids it (SC4005). UIKit owns the run loop and calls us.
let invokes = 0;

/** The whole IPC surface: one export, JSON in / JSON out. */
export function handleInvoke(cmd: string, argsJson: string): string {
  invokes = invokes + 1;

  if (cmd === "add") {
    const a = JSON.parse(argsJson) as { a: number; b: number };
    return JSON.stringify(a.a + a.b);
  }

  if (cmd === "greet") {
    const a = JSON.parse(argsJson) as { name: string };
    return JSON.stringify("hello " + a.name + " — from a scriptc LIBRARY on iOS");
  }

  if (cmd === "unicode") {
    // Deliberate torture string: em dash, accents, astral-plane emoji.
    return JSON.stringify("— çãé 🚀 — survived the WKWebView bridge");
  }

  if (cmd === "stats") {
    return JSON.stringify({ invokes: invokes, platform: "ios" });
  }

  // A bare `null` literal ICEs the compiler (SC9001); bind it to a union first.
  const unknown: string | null = null;
  return JSON.stringify(unknown);
}
