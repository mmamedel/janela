# @scriptc/llvm-linux-x64-gnu@0.1.3 ships its helper binary without the executable bit

**Package:** `@scriptc/llvm-linux-x64-gnu` (and likely the other `@scriptc/llvm-linux-*`
optional packages) at `0.1.3`.

**Error:**
```
error SC3003: LLVM native helper package @scriptc/llvm-linux-x64-gnu is incomplete:
.../node_modules/@scriptc/llvm-linux-x64-gnu/bin/scriptc-llvm-codegen
is not readable and executable; reinstall scriptc
```

**Environment:** `ubuntu-latest` GitHub Actions runner, Node 24, pnpm 9.15.9,
`pnpm install --frozen-lockfile`. Reproduces on every desktop build, not just
`--dynamic`/FFI ones — the `SC3003` check in `native-codegen.js` (`access(binaryPath,
constants.R_OK | constants.X_OK)`) runs for every executable build on this target.

**Root cause (best guess):** the published tarball for this optional package does not
preserve the executable bit on `bin/scriptc-llvm-codegen`, and no lifecycle script
restores it. `scriptc`'s own `postinstall` (`scripts/warm-cache.mjs`) explicitly skips
invoking the native toolchain on any host `hostSupportsRuntimePack()` reports as
supported — which includes this one — so it never touches, and never chmods, the
helper binary.

**Ask:** either publish the package with the executable bit preserved (`npm pack`
followed by `tar tvf` should show `-rwxr-xr-x` on the binary), or have `postinstall`
`chmod +x` every native helper binary it ships regardless of the cache-warm skip.

**Workaround in use:** `chmod +x` in CI after `pnpm install`, tracked in
`docs/shims-to-retire.md`.
