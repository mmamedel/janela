<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/mmamedel/janela/main/packages/janela/brand/janela-mark-dark.svg">
  <img src="https://raw.githubusercontent.com/mmamedel/janela/main/packages/janela/brand/janela-mark-light.svg" alt="" width="88" align="right">
</picture>

# create-janela

Scaffold a [janela](https://www.npmjs.com/package/janela) app — desktop and
mobile in pure TypeScript, compiled to a native binary. No Rust, no Node, no
Electron.

```bash
pnpm create janela
# or
npm create janela@latest
yarn create janela
bun create janela
```

It asks for a project name and a template, then hands off to `janela init`,
which scaffolds the project **and installs its dependencies** — so the next
command is `janela dev`, with nothing in between.

```
  janela — desktop and mobile apps in pure TypeScript

  ? Project name (janela-app) my-app

  ? Template
      1  Vanilla  no bundler, no frontend toolchain
      2  Vue      https://vuejs.org
      3  React    https://react.dev
      4  Svelte   https://svelte.dev
      5  Solid    https://solidjs.com
  choose 1-5 (1) 2

added 58 packages in 3s
janela: created my-app/ (vue) — next: cd my-app && janela dev
```

## Unattended

Everything it asks can be passed instead, so the same command works in a
script or in CI. `npm create` forwards flags after `--`; pnpm, yarn and bun
take them directly.

```bash
npm create janela@latest my-app -- --template vue --yes
pnpm create janela my-app --template svelte --no-install
```

| flag | |
|---|---|
| `--template <t>` | `vanilla` · `vue` · `react` · `svelte` · `solid` |
| `--yes` | accept the defaults and ask nothing (implied when stdin is not a TTY) |
| `--no-install` | scaffold without installing dependencies |
| `--help` | usage |

A mistyped flag is an error with a did-you-mean, never a silent fallback — a
tool you run once is the worst place to quietly do something else.

## What it is not

It holds no templates and no scaffolding logic of its own. Those live in
`janela`, which it depends on and invokes, so there is exactly one
implementation of each and a template fix does not need a release here.

MIT. Docs: **[mmamedel.github.io/janela](https://mmamedel.github.io/janela/)**
