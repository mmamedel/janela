// Does janela's real shape survive? user setup() registers closures at init;
// one exported entry dispatches by name.
type Handler = (argsJson: string) => string;

class LibApp {
  names: string[] = [];
  handlers: Handler[] = [];
  command(name: string, h: Handler): void {
    this.names.push(name);
    this.handlers.push(h);
  }
}

const app = new LibApp();

function setup(a: LibApp): void {
  a.command("add", (argsJson) => {
    const x = JSON.parse(argsJson) as { a: number; b: number };
    return JSON.stringify(x.a + x.b);
  });
  a.command("greet", (argsJson) => {
    const x = JSON.parse(argsJson) as { name: string };
    return JSON.stringify("hi " + x.name);
  });
}

let ready = false;

export function handleInvoke(cmd: string, argsJson: string): string {
  if (!ready) {
    setup(app);
    ready = true;
  }
  for (let i = 0; i < app.names.length; i++) {
    if (app.names[i] === cmd) return app.handlers[i](argsJson);
  }
  const miss: string | null = null;
  return JSON.stringify(miss);
}
