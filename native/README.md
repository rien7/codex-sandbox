# Native sources

This directory contains the native side of `codex-sandbox`.

## Layout

```text
native/
  vendor/
    codex-rs/
```

`vendor/codex-rs/` is a curated source subset copied out of Codex. It includes the host binary source, shell-escalation code, and the internal crates needed to build them.

## Build

From the repo root:

```bash
pnpm run build:native
```

That runs cargo builds against `native/vendor/codex-rs/Cargo.toml`.

## Bridge assets

The Rust workspace builds `codex-execve-wrapper`, but it does not build patched `zsh`.

To package the bridge, provide one of:

- `CODEX_SANDBOX_ZSH_BINARY`
- `CODEX_SANDBOX_ZSH_TARBALL`

