# SPIKE: library-mode inversion (throwaway — not shipped)

Answers whether janela can invert: native shell owns `main()`, TypeScript is a
linked scriptc **library**, instead of today's "TS owns main, calls C via FFI".

| dir | what it proves |
|---|---|
| `q1q2/` | library mode **refuses all async surface** (SC4005); string/bytes returns **work** |
| `q3-app/` | a C++ shell owning `main()` + a scriptc library serving a real webview IPC round trip |
| `q4/` | `console.log` from a library reaches stdout |
| `q4b/` | janela's real shape survives: class + closure registry + dispatch-by-name |
| `ice3/` | minimal repro of a NEW compiler crash: `JSON.stringify(null)` |

Build: `node <scriptc> build --lib --profile profile.json`, then link the
archive with the C/C++ driver in each dir. Nothing here is wired into the
janela package.
