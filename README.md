# codex-sandbox

`codex-sandbox` is a standalone repo that splits the sandbox host pieces out of Codex and packages them for reuse.

It contains three main layers:

1. `native/vendor/codex-rs/`
   A curated source subtree with the shell-escalation wrapper code and vendored native support crates.
2. `native/sandbox-host/`
   A standalone native sandbox host crate that implements the stdio JSON-RPC surface without depending on `codex-core`.
3. `packages/codex-sandbox-adapter/`
   A publishable TypeScript package that talks to the native host over stdio JSON-RPC and ships packaged binaries.
4. `packages/codex-sandbox-cli/`
   A CLI for testing the sandbox flow with inline approval prompts.

It also includes:

- `examples/minimal-ts/` for a minimal Node integration
- `docs/` for architecture notes and the wire protocol
- `LICENSE` and `NOTICE` copied from Codex

## Origin

This project is derived from OpenAI Codex. The native host and shell-escalation pieces come from a curated subset of Codex source code. This repo keeps the Apache-2.0 license and NOTICE text aligned with the original project.

## Build

```bash
pnpm install
pnpm run build
```

`pnpm run build` does three things:

1. builds the standalone native host from `native/sandbox-host` and the execve wrapper from `native/vendor/codex-rs`
2. copies the built binaries into the adapter package
3. builds the TypeScript adapter, CLI, and example

If you want patched `zsh` bridge support, provide one of these before `pnpm run sync:native` or `pnpm run build`:

- `CODEX_SANDBOX_ZSH_BINARY`
- `CODEX_SANDBOX_ZSH_TARBALL`

## Quick start

Run the CLI against the packaged host:

```bash
pnpm --dir packages/codex-sandbox-cli start -- exec --cmd 'printf hello'
```

If the sandbox needs approval, the CLI asks inline and then continues with the same command flow.

Run the minimal example:

```bash
pnpm --dir examples/minimal-ts start
```

## Packages

- `@rien7/codex-sandbox`
  TypeScript adapter for the host protocol. It resolves packaged binaries and manages `CODEX_HOME`.
- `@codex-sandbox/cli`
  Interactive CLI that uses the adapter package and prompts for approvals inline.

## Other languages

The native host speaks newline-delimited JSON-RPC over stdio. You can spawn the host from any language and implement the same request and notification flow. See [docs/other-languages.md](./docs/other-languages.md).
