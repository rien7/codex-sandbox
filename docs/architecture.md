# Architecture

`codex-sandbox` keeps the split between native execution and high-level client code.

## Layers

### Native host

The native host owns:

- sandbox execution
- command/session lifecycle
- Codex shell-escalation integration
- approval request notifications

The curated source lives under `native/vendor/codex-rs/`.

### TypeScript adapter

The adapter owns:

- native binary resolution
- `CODEX_HOME` preparation
- request/response wiring over stdio JSON-RPC
- session output capture for interactive commands
- approval callback routing

### CLI

The CLI owns:

- argument parsing
- inline approval prompts
- interactive terminal loop for `writeStdin`
- user-facing output formatting

## Binary layout

After `pnpm run sync:native`, the adapter package carries these files:

```text
packages/codex-sandbox-adapter/native/<platform>/
  codex-sandbox-host
  codex-execve-wrapper
  zsh
```

Only `codex-sandbox-host` is required for buffered command execution. The bridge assets are optional and are copied when available.

