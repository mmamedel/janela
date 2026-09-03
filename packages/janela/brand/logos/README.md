# Logo sources

Authoring inputs, not package files. The starter templates **inline** these,
so nothing here is read at build or run time and none of it ships in the npm
tarball (`files` in package.json does not include `brand/`).

- `janela.svg` — generated from `../janela-mark.svg`
- `vite.svg`, `vue.svg`, `react.svg`, `svelte.svg`, `solid.svg` — each
  project's own mark, as vendored by
  [create-tauri-app](https://github.com/tauri-apps/create-tauri-app/tree/main/templates/_assets_)
  (MIT). Normalised for inlining: `xmlns:xlink` removed (unused, and a colon in
  an attribute name is a hard error in TSX), `width`/`height` removed so the
  stylesheet drives the size, and the `logo <name>` class merged into any
  existing `class` rather than added as a second one — a duplicate attribute
  fails both the Vue compiler and `tsc`.
