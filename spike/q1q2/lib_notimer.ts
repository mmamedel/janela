// SPIKE — not shipped. Probes library-mode: async posture + bytes/string returns.
let ticks = 0;
let timerFired = false;
let promiseSettled = false;

export function scheduleWork(): number {
  setTimeout(() => {
    timerFired = true;
  }, 0);
  return 0;
}

export function pollState(): number {
  ticks = ticks + 1;
  let bits = 0;
  if (timerFired) bits = bits + 1;
  if (promiseSettled) bits = bits + 2;
  return bits;
}

export function ticksSoFar(): number {
  return ticks;
}

export function greet(name: string): string {
  return "hello " + name;
}

export function makeBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = i & 0xff;
  return out;
}
