#!/usr/bin/env node
// create-janela — the `pnpm create tauri-app` analogue.
//
//   pnpm create janela            # or: npm create janela@latest
//                                 #     yarn create janela
//                                 #     bun create janela
//
// Asks for a project name and a template, then hands off to `janela init`,
// which does the scaffolding and installs the dependencies. Everything this
// asks can also be passed as an argument, so the same command works
// unattended:
//
//   npm create janela@latest my-app -- --template vue --yes
//
// Zero dependencies beyond janela itself: the prompts are node:readline, so
// there is no dependency tree to audit for a tool that runs once.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

/**
 * Where the janela package lives.
 *
 * `./package.json` is in janela's exports map, so this resolves without
 * depending on any internal path. Its `bin/` and `templates/` are then reached
 * as plain files — importing by absolute path bypasses the exports map, which
 * is what we want for a sibling tool that ships alongside it.
 */
function janelaRoot() {
  try {
    return dirname(require.resolve("janela/package.json"));
  } catch {
    die(
      "create-janela could not find its own copy of janela.\n" +
        "  This should not happen from `pnpm create janela`; if you are running a\n" +
        "  checkout directly, install its dependencies first.",
    );
  }
}

function die(msg) {
  console.error(`create-janela: ${msg}`);
  process.exit(1);
}

// Colour only when someone is actually looking: piped into a file or a CI log,
// escape sequences are noise. NO_COLOR is the de-facto opt-out.
const colour = stdout.isTTY && !process.env.NO_COLOR;
const sgr = (code) => (s) => (colour ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const C = {
  dim: sgr(2),
  bold: sgr(1),
  blue: sgr(34),
  green: sgr(32),
};

const TEMPLATES = [
  { id: "vanilla", label: "Vanilla", note: "no bundler, no frontend toolchain" },
  { id: "vue", label: "Vue", note: "https://vuejs.org" },
  { id: "react", label: "React", note: "https://react.dev" },
  { id: "svelte", label: "Svelte", note: "https://svelte.dev" },
  { id: "solid", label: "Solid", note: "https://solidjs.com" },
];

// ---- arguments ---------------------------------------------------------------

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);

function opt(name) {
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--")) return argv[i + 1];
  return undefined;
}

// A mistyped flag must not be ignored in silence — the whole point of this
// tool is that it is run once, so a silently wrong template is a project the
// caller then has to notice is wrong.
const KNOWN = ["template", "yes", "no-install", "help"];
for (const a of argv) {
  if (!a.startsWith("--")) continue;
  const nm = a.slice(2).split("=")[0];
  if (!KNOWN.includes(nm)) {
    const near = KNOWN.filter((k) => k.startsWith(nm.slice(0, 3)));
    die(
      `unknown option '--${nm}'.\n` +
        `  Known options: ${KNOWN.map((k) => `--${k}`).join(", ")}` +
        (near.length ? `\n  Did you mean --${near[0]}?` : ""),
    );
  }
}

if (has("--help")) {
  console.log(
    `create-janela — scaffold a janela app\n\n` +
      `usage: npm create janela@latest [name] -- [--template ${TEMPLATES.map((t) => t.id).join("|")}]\n` +
      `                                          [--yes] [--no-install]\n\n` +
      `  --yes         accept the defaults, ask nothing\n` +
      `  --no-install  scaffold without installing dependencies\n`,
  );
  process.exit(0);
}

// The first bare argument is the project name. `npm create` forwards flags
// after `--`, so anything starting with a dash is never the name.
const positional = argv.filter((a) => !a.startsWith("--"));
const flagValues = new Set(
  KNOWN.map((k) => opt(k)).filter((v) => v !== undefined),
);
const nameArg = positional.find((p) => !flagValues.has(p));

// ---- prompts -----------------------------------------------------------------

const DEFAULT_NAME = "janela-app";
const interactive = stdin.isTTY && stdout.isTTY && !has("--yes");

async function main() {
  const root = janelaRoot();
  const { NAME_RE, suggestName } = await import(
    pathToFileURL(join(root, "bin", "lib.mjs")).href
  );

  /** A name janela will accept, and that is not already a directory here. */
  function checkName(raw) {
    const value = String(raw ?? "").trim();
    if (!value) return "a project name is required";
    if (!NAME_RE.test(value)) {
      const hint = suggestName(value);
      return (
        `'${value}' is not a usable project name (lowercase letters, digits, - and _; must start with a letter)` +
        (hint && NAME_RE.test(hint) ? ` — try '${hint}'` : "")
      );
    }
    if (existsSync(resolve(process.cwd(), value))) return `./${value} already exists`;
    return null;
  }

  let name = nameArg;
  let template = opt("template");

  if (template !== undefined && !TEMPLATES.some((t) => t.id === template)) {
    die(`unknown template '${template}' (${TEMPLATES.map((t) => t.id).join(", ")})`);
  }

  if (!interactive) {
    // Unattended: a bad name is fatal rather than re-prompted, because there
    // is nobody to re-prompt.
    name ??= DEFAULT_NAME;
    const bad = checkName(name);
    if (bad) die(`${bad}.\n  Pass a name: npm create janela@latest <name>`);
    template ??= "vanilla";
  } else {
    console.log(`\n  ${C.bold("janela")} ${C.dim("— desktop and mobile apps in pure TypeScript")}\n`);
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      while (checkName(name)) {
        if (name !== undefined) console.log(`  ${C.dim("!")} ${checkName(name)}`);
        const answer = await rl.question(`  ${C.green("?")} Project name ${C.dim(`(${DEFAULT_NAME})`)} `);
        name = answer.trim() || DEFAULT_NAME;
      }

      if (template === undefined) {
        console.log(`\n  ${C.green("?")} Template`);
        TEMPLATES.forEach((t, i) => {
          console.log(`      ${C.blue(String(i + 1))}  ${t.label.padEnd(8)} ${C.dim(t.note)}`);
        });
        while (template === undefined) {
          const answer = (await rl.question(`  ${C.dim("choose 1-5 (1)")} `)).trim() || "1";
          const byIndex = TEMPLATES[Number(answer) - 1];
          const byName = TEMPLATES.find((t) => t.id === answer.toLowerCase());
          if (byIndex ?? byName) template = (byIndex ?? byName).id;
          else console.log(`  ${C.dim("!")} pick a number 1-5, or a name`);
        }
      }
    } finally {
      rl.close();
    }
    console.log("");
  }

  // janela init owns the scaffolding, the name validation and the install, so
  // there is exactly one implementation of each and this stays a front end.
  const cli = join(root, "bin", "janela.mjs");
  if (!existsSync(cli)) die(`janela's CLI is missing at ${cli}`);

  const args = [cli, "init", name, "--template", template];
  if (has("--no-install")) args.push("--no-install");

  const r = spawnSync(process.execPath, args, { stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);

  console.log(
    `\n  ${C.dim("Mobile:")} janela dev --target ios ${C.dim("|")} janela dev --target android\n` +
      `  ${C.dim("Docs:  ")} https://mmamedel.github.io/janela/\n`,
  );
}

await main();
