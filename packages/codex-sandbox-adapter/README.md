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
- preparing the host configuration directory
- speaking newline-delimited JSON-RPC over stdio

## Concept

### Terminology

Some words used in this package are easy to mix up:

- `adapter`: the TypeScript wrapper you call from your app
- `native host`: the separate `codex-sandbox-host` process that actually runs commands
- `bridge`: optional native helper binaries that make shell startup sandbox-aware
- `approval request`: a message from the native host asking whether a guarded command may run
- `approval resolver`: your callback that decides how to answer an approval request

### What the adapter does

At a high level, the adapter is a small orchestration layer around a native
`codex-sandbox-host` process.

It is responsible for:

- resolving the native host binary
- preparing a dedicated config directory for that host
- discovering optional bridge assets when they are available
- forwarding `exec()` and `writeToSession()` calls over stdio
- converting approval requests from the host into a simple TypeScript callback

If you are new to this project, the important idea is that the TypeScript
package does not itself execute commands. It launches and manages a separate
native host process that does the real work.

### Execution model

The adapter keeps one native host process alive and reuses it across calls.

That means:

- `exec()` sends one command to the host and returns a normalized result
- `exec({ tty: true })` may return a live session instead of a finished result
- `writeToSession()` only applies to an already-running PTY session
- `close()` shuts the host down and drops any adapter-held session state

This model matters because approvals, sessions, and bridge setup all happen in
the host process, not in your Node.js process.

### Native asset resolution

The adapter tries these locations in order:

1. Explicit option values
2. Environment overrides
3. Packaged npm assets under `native/<platform>/...`
4. `dist/native/<platform>/...` in the current directory or any ancestor
5. Direct repo build outputs in the current directory or any ancestor
6. Matching system binaries on `PATH`

### Bridge

The bridge is the extra native layer that helps the host launch shell commands
in a sandbox-aware way.

In practice, it is usually a pair of native binaries:

- a patched shell binary, often `zsh`
- a small exec wrapper, `codex-execve-wrapper`

The adapter uses bridge assets when they are available so the host can intercept
command startup cleanly and route it through the sandbox-aware execution path.

You normally do not need to configure the bridge manually. If the package ships
prebuilt native assets, or if you are running from the repository layout, the
adapter will try to find them automatically.

Bridge configuration is only useful when:

- you want to pin a custom native build
- you are using a nonstandard filesystem layout
- you need to disable the bridge layer entirely

Bridge options:

- `enabled: false` disables bridge setup even if bridge assets are found
- `zshBinary` overrides the shell binary used by the bridge
- `execveWrapperBinary` overrides the exec wrapper used by the bridge

Bridge lifecycle in practice:

- the adapter looks for packaged bridge assets automatically
- if it finds them, it writes a managed host config that points at those binaries
- if you disable the bridge, the adapter skips that extra setup
- if you provide custom paths, those explicit paths win

Environment overrides:

```bash
export CODEX_SANDBOX_HOST_BINARY=/absolute/path/to/codex-sandbox-host
export CODEX_SANDBOX_ZSH_BINARY=/absolute/path/to/zsh
export CODEX_SANDBOX_EXECVE_WRAPPER_BINARY=/absolute/path/to/codex-execve-wrapper
```

### Configuration directory

`configPath` is the configuration directory used for the native host runtime.

Internally it is passed to the host as `CODEX_HOME`, but you can think of it as
“where the adapter-managed host config lives”.

When bridge assets are available, the adapter writes a managed `config.toml`
into that directory so the shell integration can find:

- `zsh`
- `codex-execve-wrapper`

Non-managed configs are left untouched.

If you are only using the high-level adapter API, you usually do not need to
touch this directory yourself.

If you do override it, keep in mind:

- the directory must be writable by the current process
- sharing one config path across unrelated runs can make debugging harder
- deleting the directory removes the managed host config, but not the native binaries themselves

## Quick Start

### Install

```bash
npm install @rien7/codex-sandbox
```

### Default behavior

`CodexShellAdapter` is designed to work without manually passing `configPath`,
`hostBinary`, or `bridge`.

Defaults:

- `configPath`: `~/.config/codex-sandbox` on Unix-like systems, and a platform-appropriate app config directory on Windows
- `cwd`: `process.cwd()`
- `shell`: `options.shell`, then `$SHELL`, then `%ComSpec%` on Windows, otherwise `/bin/zsh`
- `sandboxPermissions`: `useDefault`
- `login`: `true`
- `tty`: `false`

### Minimal usage

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

### Command options

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

## Workflow

### Approval flow

Guarded commands can emit an approval request before execution.

The sequence is:

1. You call `adapter.exec()` or `adapter.writeToSession()`
2. The native host decides that the command needs approval
3. The host emits an approval request
4. The adapter calls `approvalResolver(request, context)` if one is configured
5. The resolver returns a decision
6. The adapter sends that decision back to the host
7. The host either continues execution or rejects the request

This means `approvalResolver` is a pre-execution policy hook. It is not a
post-execution callback and it does not modify the sandbox after the command
starts.

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

How to think about the choices:

- use `accept` when the command is safe, but you only want this one request approved
- use `acceptForSession` when several guarded commands in the same host lifetime should reuse the same approval
- use `decline` when the command should never run
- use `cancel` when you want to stop without treating it as a policy rejection

Current behavior notes:

- `acceptForSession` requires no extra configuration
- the remembered approval lasts only as long as the current adapter/native host process
- `adapter.close()` clears that state by shutting down the host
- `decline` and `cancel` both stop execution; the current host returns a non-zero completion with the decision encoded in the output payload
- if the host limits `availableDecisions`, the resolver should pick one of the allowed values

`sandboxPermissions` and `approvalResolver` solve different problems:

- `sandboxPermissions` says how sensitive the command is
- `approvalResolver` decides what to do when the host asks for approval

The common pattern is:

- use `useDefault` for ordinary commands
- use `requireEscalated` when the command is sensitive or likely to need extra approval
- return `acceptForSession` only when you want the current host process to remember that approval

### One-off approval example

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

### Session approval example

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

### Rejected path example

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

### Interactive sessions

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

### Explicit path overrides

You only need to pass explicit native paths when:

- you want to pin a specific local build
- you are embedding the package in a custom layout
- you do not want resolver auto-discovery

```ts
import { CodexShellAdapter } from '@rien7/codex-sandbox'

const adapter = new CodexShellAdapter({
  hostBinary: '/opt/codex-sandbox/codex-sandbox-host',
  configPath: '/tmp/codex-sandbox-config',
  bridge: {
    zshBinary: '/opt/codex-sandbox/zsh',
    execveWrapperBinary: '/opt/codex-sandbox/codex-execve-wrapper',
  },
})
```

## Reference

### Low-level APIs

Most consumers should stay with `CodexShellAdapter`.

Lower-level exports exist when you need them:

- `CodexShellHostClient`: own one native host process directly and speak the raw JSON-RPC protocol
- `resolveNativeShellBundle()`: resolve the host binary and optional bridge assets with the same discovery logic as the adapter
- `resolveNativeHostBinary()`: locate only the host binary
- `resolveNativeShellBridge()`: locate only the bridge binaries
- `getNativePlatformKey()`: inspect the platform key used for packaged native lookup
- `prepareConfigPath()`: create or update the managed host config directory before launch

Use these when you need to embed the host in a custom runtime, debug startup issues, or bypass the high-level session management.

### Packaged native layout

The published package is expected to include:

```text
native/<platform>/
  codex-sandbox-host
  codex-execve-wrapper
  zsh
```

### Developing in this repo

Inside this repository:

```bash
pnpm run build:native
pnpm run sync:native
pnpm --dir packages/codex-sandbox-adapter build
```

After that, `new CodexShellAdapter()` can resolve repo-local builds from the current directory or any ancestor directory.

## Troubleshooting

If things do not start the way you expect, check these first:

- `hostBinary` or `CODEX_SANDBOX_HOST_BINARY` may point at the wrong binary
- the bridge may be disabled, which changes how shell startup is handled
- `configPath` may not be writable
- your `approvalResolver` may be returning a decision that is not allowed by the host
- you may be reusing a session id after the adapter has been closed

When debugging native startup issues, it is usually more useful to inspect the
resolved host and bridge paths than to look at the high-level API first.
