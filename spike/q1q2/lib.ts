// SPIKE — library-mode probe: bytes/string returns, no async surface.
let calls = 0;

export function greet(name: string): string {
  calls = calls + 1;
  return "hello " + name + " — çãé 🚀";
}

export function makeBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = i & 0xff;
  return out;
}

export function callCount(): number {
  return calls;
}
