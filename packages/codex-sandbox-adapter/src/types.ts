import type { HostApprovalDecision } from './protocol.js'

/** High-level sandbox policy used by the adapter when executing a command. */
export type CodexShellSandboxPermissions = 'useDefault' | 'requireEscalated'

/**
 * Approval decision returned by the adapter-level approval callback.
 *
 * Semantics:
 * - `accept`: approve only the current request
 * - `acceptForSession`: approve the current request and remember that approval
 *   for the lifetime of the current native host process
 * - `decline`: explicitly reject execution
 * - `cancel`: abort without approval
 */
export type CodexShellApprovalDecision = HostApprovalDecision

/**
 * Approval prompt emitted by the native host before a guarded command runs.
 *
 * The resolver may use `command`, `cwd`, `reason`, and `availableDecisions`
 * to decide whether to `accept`, `acceptForSession`, `decline`, or `cancel`.
 */
export interface CodexShellApprovalRequest {
  itemId: string
  approvalId: string
  command?: string
  cwd?: string
  reason?: string
  availableDecisions?: CodexShellApprovalDecision[]
}

/** Context the adapter keeps for the request that triggered an approval prompt. */
export interface CodexShellApprovalContext {
  itemId: string
  sandboxPermissions: CodexShellSandboxPermissions
}

/**
 * User-provided hook for inline approval decisions.
 *
 * Typical patterns:
 * - return `accept` for one-off approval
 * - return `acceptForSession` to reuse approval for later guarded commands in
 *   the same adapter/host lifetime
 * - return `decline` or `cancel` to stop execution
 */
export type CodexShellApprovalResolver = (
  request: CodexShellApprovalRequest,
  context: CodexShellApprovalContext | undefined,
) => Promise<CodexShellApprovalDecision> | CodexShellApprovalDecision

/** Input accepted by `adapter.exec()`. */
export interface CodexShellExecInput {
  /** Shell snippet to execute. */
  cmd: string
  /** Working directory for the command. Defaults to `options.cwd` or `process.cwd()`. */
  cwd?: string
  /** Extra environment variables merged on top of `process.env`. */
  env?: Record<string, string>
  /** Optional hard timeout in milliseconds for non-interactive commands. */
  timeoutMs?: number
  /** How long the host should wait for output before returning a chunk. */
  yieldTimeMs?: number
  /** Optional output budget used by the host and adapter to crop large output. */
  maxOutputTokens?: number
  /** Start the command under a PTY and keep the session open when needed. */
  tty?: boolean
  /** Use a login shell when spawning the command. Defaults to `true`. */
  login?: boolean
  /** Shell binary to launch. Defaults to `options.shell`, `$SHELL`, or `/bin/zsh`. */
  shell?: string
  /** Sandbox policy for the command. Defaults to `useDefault`. */
  sandboxPermissions?: CodexShellSandboxPermissions
}

/** Input accepted by `adapter.writeToSession()`. */
export interface CodexShellWriteInput {
  /** Adapter-level session id returned by `exec({ tty: true })`. */
  sessionId: string
  /** Bytes or text to write to the running PTY session. */
  chars?: string
  /** How long to wait for new output before resolving this write call. */
  yieldTimeMs?: number
  /** Optional output budget used when returning the latest chunk. */
  maxOutputTokens?: number
}

/** Normalized result returned by `exec()` and `writeToSession()`. */
export interface CodexShellResult {
  sessionId?: string
  command: string
  cwd: string
  exitCode?: number
  running: boolean
  output: string
  latestChunk: string
}

/**
 * Persisted snapshot of a running or completed session held by the adapter.
 *
 * Sessions are created by `exec({ tty: true })` and then updated through
 * `writeToSession()`.
 */
export interface CodexShellSessionSnapshot extends CodexShellResult {
  sandboxPermissions: CodexShellSandboxPermissions
}

/** Optional shell bridge assets used to patch zsh exec behavior. */
export interface CodexShellBridgeOptions {
  /** Set to `false` to disable bridge setup even if packaged assets are available. */
  enabled?: boolean
  /** Explicit path to the patched `zsh` binary. */
  zshBinary?: string
  /** Explicit path to the `codex-execve-wrapper` bridge binary. */
  execveWrapperBinary?: string
}

/** Top-level configuration for `CodexShellAdapter`. All fields are optional. */
export interface CodexShellAdapterOptions {
  /**
   * Explicit path to `codex-sandbox-host`.
   *
   * Usually not needed. The adapter resolves packaged assets, ancestor repo
   * builds, environment overrides, and finally `PATH`.
   */
  hostBinary?: string
  /**
   * Dedicated `CODEX_HOME` directory.
   *
   * Defaults to `~/.codex-sandbox`.
   */
  codexHome?: string
  /** Default shell binary for commands. */
  shell?: string
  /** Default command working directory and native asset search starting point. */
  cwd?: string
  /** Extra environment variables passed to the native host process. */
  env?: NodeJS.ProcessEnv
  /** Extra argv appended when spawning `codex-sandbox-host`. */
  launchArgs?: string[]
  /**
   * Inline approval callback for guarded commands.
   *
   * This is where you choose between `accept`, `acceptForSession`,
   * `decline`, and `cancel`.
   */
  approvalResolver?: CodexShellApprovalResolver
  /**
   * Optional bridge overrides.
   *
   * Usually not needed when the package ships native assets or when the host
   * and bridge binaries are built in the repo.
   */
  bridge?: CodexShellBridgeOptions
}
