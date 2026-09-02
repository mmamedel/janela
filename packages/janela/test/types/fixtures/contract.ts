// The contract every fixture shares: written the way a project writes it, as
// plain function types, with a zero-argument command and one event.
import type { JanelaApp } from "janela/host";

export type AppCommands = {
  add: (args: { a: number; b: number }) => number;
  greet: (args: { name: string }) => string;
  wait: (args: { ms: number }) => string;
  quit: () => void;
};

export type AppEvents = { added: number };

export type App = JanelaApp<AppCommands, AppEvents>;
