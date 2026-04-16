# minimal-ts example

This example shows the standalone adapter in three steps:

1. A normal command that runs without approval
2. A command that requests escalated sandbox permissions
3. An interactive TTY session that reuses the earlier approval and then receives input through `writeToSession`

## Run

From the repo root:

```bash
pnpm run build:native
pnpm run sync:native
pnpm --dir packages/codex-sandbox-adapter build
pnpm --dir examples/minimal-ts build
pnpm --dir examples/minimal-ts start
```

## What the example prints

The script prints the paths it is using before it starts the shell host:

- repo root
- example root
- resolved platform key
- example workdir
- `CODEX_HOME`
- resolved host binary path and source
- resolved bridge asset paths and sources when available
- the main repo-native locations that the adapter resolver checks

The script then runs:

1. `normal-case`
2. `escalated-case`
3. an interactive `read`/`echo` flow

## Resolver path order

The adapter resolves assets in this order:

1. Explicit option values such as `hostBinary`
2. Environment overrides
3. Packaged adapter assets under `packages/codex-sandbox-adapter/native/<platform>/...`
4. Synced repo assets under `dist/native/<platform>/...`
5. Direct build outputs under:
   - `native/sandbox-host/target/release/sandbox-unified-exec-host`
   - `native/vendor/codex-rs/target/release/codex-execve-wrapper`
6. System binaries on `PATH`

Relevant environment overrides:

```bash
export CODEX_SANDBOX_HOST_BINARY=/absolute/path/to/codex-sandbox-host
export CODEX_SANDBOX_ZSH_BINARY=/absolute/path/to/zsh
export CODEX_SANDBOX_EXECVE_WRAPPER_BINARY=/absolute/path/to/codex-execve-wrapper
```

## Interactive flow

The interactive case uses:

```ts
const session = await adapter.exec({
  cmd: 'printf "interactive-ready\\n"; read -r line; printf "interactive-echo:%s\\n" "$line"',
  tty: true,
  sandboxPermissions: 'requireEscalated',
})

await adapter.writeToSession({
  sessionId: session.sessionId!,
  chars: 'hello-from-session\\n',
})
```

That shows the intended lifecycle:

1. start a TTY command
2. receive a running session with `sessionId`
3. send input with `writeToSession`
4. inspect `getSessionSnapshot()` or `listSessions()`
5. close with `terminateSession()` if the command is still running
