# Native sources

This directory contains the native side of `codex-sandbox`.

## Layout

```text
native/
  sandbox-host/
  vendor/
    codex-rs/
```

`sandbox-host/` contains the standalone native host crate used by this repo.

`vendor/codex-rs/` is a curated source subset copied out of Codex. It now exists to build the shell-escalation wrapper and keep the bridge assets aligned with upstream Codex code.

## Build

From the repo root:

```bash
pnpm run build:native
```

That builds the host from `native/sandbox-host/Cargo.toml` and the exec wrapper from `native/vendor/codex-rs/Cargo.toml`.

## Bridge assets

The Rust workspace builds `codex-execve-wrapper`, but it does not build patched `zsh`.

To package the bridge, provide one of:

- `CODEX_SANDBOX_ZSH_BINARY`
- `CODEX_SANDBOX_ZSH_TARBALL`
