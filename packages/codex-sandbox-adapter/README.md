# @rien7/codex-sandbox

TypeScript adapter for the standalone `codex-sandbox-host`.

It is meant to be the high-level API. In the normal case you should only need:

1. `new CodexShellAdapter()`
2. `adapter.exec()`
3. `adapter.writeToSession()` for TTY sessions
4. `adapter.close()`

The adapter handles:

- resolving the native host binary
- resolving bridge assets when present
- preparing a managed `CODEX_HOME`
- speaking newline-delimited JSON-RPC over stdio

## Install

```bash
npm install @rien7/codex-sandbox
```

## Default behavior

`CodexShellAdapter` is designed to work without manually passing `codexHome`, `hostBinary`, or `bridge`.

Defaults:

- `codexHome`: `~/.codex-sandbox`
- `cwd`: `process.cwd()`
- `shell`: `options.shell`, then `$SHELL`, then `/bin/zsh`
- `sandboxPermissions`: `useDefault`
- `login`: `true`
- `tty`: `false`

## Native asset resolution

The adapter tries these locations in order:

1. Explicit option values
2. Environment overrides
3. Packaged npm assets under `native/<platform>/...`
4. `dist/native/<platform>/...` in the current directory or any ancestor
5. Direct repo build outputs in the current directory or any ancestor
6. Matching system binaries on `PATH`

Environment overrides:

```bash
export CODEX_SANDBOX_HOST_BINARY=/absolute/path/to/codex-sandbox-host
export CODEX_SANDBOX_ZSH_BINARY=/absolute/path/to/zsh
export CODEX_SANDBOX_EXECVE_WRAPPER_BINARY=/absolute/path/to/codex-execve-wrapper
```

## Minimal usage

```ts
import { CodexShellAdapter } from '@rien7/codex-sandbox'

const adapter = new CodexShellAdapter()

try {
  const result = await adapter.exec({
    cmd: 'printf "hello from sandbox\\n"',
  })

  console.log(result.output)
}
finally {
  await adapter.close()
}
```

## Command options

```ts
const result = await adapter.exec({
  cmd: 'printf "hello\\n"; pwd',
  cwd: '/tmp',
  env: { DEMO_FLAG: '1' },
  timeoutMs: 5_000,
  yieldTimeMs: 250,
  maxOutputTokens: 512,
  shell: '/bin/zsh',
  login: true,
  sandboxPermissions: 'useDefault',
})
```

Important fields:

- `cmd`: shell snippet to run
- `cwd`: command working directory
- `env`: extra environment variables merged over `process.env`
- `timeoutMs`: hard timeout for non-interactive execution
- `yieldTimeMs`: how long the host waits before returning a chunk
- `tty`: start a PTY-backed interactive session
- `sandboxPermissions`: `useDefault` or `requireEscalated`

## Approval flow

Guarded commands can emit an approval request before execution.

Add `approvalResolver` to decide inline:

```ts
import { CodexShellAdapter } from '@rien7/codex-sandbox'

const adapter = new CodexShellAdapter({
  approvalResolver: async (request, context) => {
    if (request.command?.includes('rm -rf')) {
      return 'decline'
    }

    if (context?.sandboxPermissions === 'requireEscalated') {
      return 'acceptForSession'
    }

    return 'accept'
  },
})
```

Approval decision meanings:

- `accept`: approve only the current request
- `acceptForSession`: approve the current request and remember the approval for the current native host process
- `decline`: explicitly reject execution
- `cancel`: abort without approval

Current behavior notes:

- `acceptForSession` requires no extra configuration
- the remembered approval lasts only as long as the current adapter/native host process
- `adapter.close()` clears that state by shutting down the host
- `decline` and `cancel` both stop execution; the current host returns a non-zero completion with the decision encoded in the output payload

## One-off approval example

```ts
const result = await adapter.exec({
  cmd: 'printf "approve once\\n"',
  sandboxPermissions: 'requireEscalated',
})
```

Resolver:

```ts
approvalResolver: async () => 'accept'
```

## Session approval example

If you want one approval to cover later guarded commands in the same adapter lifetime:

```ts
const adapter = new CodexShellAdapter({
  approvalResolver: async (_request, context) => {
    if (context?.sandboxPermissions === 'requireEscalated') {
      return 'acceptForSession'
    }

    return 'accept'
  },
})
```

Then later guarded commands can reuse that decision while the adapter stays alive.

## Rejected path example

```ts
const adapter = new CodexShellAdapter({
  approvalResolver: async (request) => {
    if (request.command?.includes('dangerous-command')) {
      return 'decline'
    }

    return 'accept'
  },
})
```

## Interactive sessions

Set `tty: true` to create a live shell session:

```ts
const started = await adapter.exec({
  cmd: 'read -r line; printf "echo:%s\\n" "$line"',
  tty: true,
  sandboxPermissions: 'requireEscalated',
})

if (started.sessionId) {
  const update = await adapter.writeToSession({
    sessionId: started.sessionId,
    chars: 'hello\n',
  })

  console.log(update.output)
}
```

Session helpers:

- `adapter.getSessionSnapshot(sessionId)`
- `adapter.listSessions()`
- `adapter.terminateSession(sessionId)`

## Explicit path overrides

You only need to pass explicit native paths when:

- you want to pin a specific local build
- you are embedding the package in a custom layout
- you do not want resolver auto-discovery

```ts
import { CodexShellAdapter } from '@rien7/codex-sandbox'

const adapter = new CodexShellAdapter({
  hostBinary: '/opt/codex-sandbox/codex-sandbox-host',
  codexHome: '/tmp/codex-sandbox-home',
  bridge: {
    zshBinary: '/opt/codex-sandbox/zsh',
    execveWrapperBinary: '/opt/codex-sandbox/codex-execve-wrapper',
  },
})
```

## Managed `CODEX_HOME`

When bridge assets are available, the adapter writes a managed `config.toml` into `CODEX_HOME` so the shell integration can find:

- `zsh`
- `codex-execve-wrapper`

Non-managed configs are left untouched.

Low-level helper:

```ts
import { prepareCodexHome } from '@rien7/codex-sandbox'
```

## Low-level APIs

Most consumers should stay with `CodexShellAdapter`.

Lower-level exports exist when you need them:

- `CodexShellHostClient`
- `resolveNativeShellBundle()`
- `resolveNativeHostBinary()`
- `resolveNativeShellBridge()`
- `getNativePlatformKey()`
- `prepareCodexHome()`

## Packaged native layout

The published package is expected to include:

```text
native/<platform>/
  codex-sandbox-host
  codex-execve-wrapper
  zsh
```

## Developing in this repo

Inside this repository:

```bash
pnpm run build:native
pnpm run sync:native
pnpm --dir packages/codex-sandbox-adapter build
```

After that, `new CodexShellAdapter()` can resolve repo-local builds from the current directory or any ancestor directory.
