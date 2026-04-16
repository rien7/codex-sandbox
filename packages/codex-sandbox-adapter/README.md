# @codex-sandbox/adapter

This package wraps the standalone `codex-sandbox-host` binary.

It resolves packaged binaries, prepares `CODEX_HOME`, and speaks newline-delimited JSON-RPC over stdio.

## Install

```bash
npm install @codex-sandbox/adapter
```

## Use

```ts
import { CodexShellAdapter } from '@codex-sandbox/adapter'

const adapter = new CodexShellAdapter()
const result = await adapter.exec({ cmd: 'printf hello' })
console.log(result.output)
await adapter.close()
```

## Packaged binaries

The published package is expected to ship:

```text
native/<platform>/
  codex-sandbox-host
  codex-execve-wrapper
  zsh
```

The adapter can also use explicit paths or environment variables when you want to provide your own build.

