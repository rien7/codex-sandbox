import type { HostApprovalDecision } from './protocol.js'

/**
 * High-level sandbox policy used by the adapter when executing a command.
 *
 * This is not an OS-level sandbox setting. It is the request-level policy that
 * the adapter sends to the native host so the host can decide whether a command
 * may run with its default handling or whether it should go through an
 * escalated approval path.
 */
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
 *
 * This is the low-level "what needs approval?" payload. It is emitted before
 * the command executes, and it is paired with a separate `approvalId` so the
 * host can receive exactly one decision for this request.
 */
export interface CodexShellApprovalRequest {
  /** Adapter-generated identifier that ties this approval prompt back to the originating command. */
  itemId: string
  /** Host-generated identifier used to send one decision back for this exact approval prompt. */
  approvalId: string
  /** Original shell snippet being considered for approval, when the host includes it. */
  command?: string
  /** Working directory associated with the request, when available. */
  cwd?: string
  /** Host-supplied short explanation for why approval is needed, when available. */
  reason?: string
  /** Decisions the host says are valid for this request. Undefined means "any supported decision". */
  availableDecisions?: CodexShellApprovalDecision[]
}

/**
 * Context the adapter keeps for the request that triggered an approval prompt.
 *
 * This is adapter-owned metadata, not a host payload. Right now it mainly tells
 * you which sandbox policy was used to start the command, so a resolver can
 * treat `requireEscalated` requests differently from ordinary `useDefault`
 * requests.
 */
export interface CodexShellApprovalContext {
  /** Same adapter-generated identifier used by the request object. */
  itemId: string
  /** Sandbox policy chosen for the command that triggered the approval request. */
  sandboxPermissions: CodexShellSandboxPermissions
}

/**
 * User-provided hook for inline approval decisions.
 *
 * The adapter calls this after the native host emits an approval request and
 * before it sends a decision back to the host.
 *
 * Use this hook when you want to centralize approval policy in code instead of
 * asking a human every time. Common examples:
 *
 * - allow a known-safe command with `accept`
 * - allow an escalation once and reuse that approval for the current host
 *   process with `acceptForSession`
 * - block patterns like destructive file operations with `decline`
 * - abort without approval using `cancel`
 *
 * The resolver should be treated as a pure policy function. It can inspect the
 * request and context and return a decision, but it should not assume that the
 * command has already started executing.
 */
export type CodexShellApprovalResolver = (
  request: CodexShellApprovalRequest,
  context: CodexShellApprovalContext | undefined,
) => Promise<CodexShellApprovalDecision> | CodexShellApprovalDecision

/** Input accepted by `adapter.exec()`. */
export interface CodexShellExecInput {
  /** Shell snippet to execute. This is passed to the configured shell, not run directly by Node.js. */
  cmd: string
  /** Working directory for the command. Defaults to `options.cwd` or `process.cwd()`. */
  cwd?: string
  /** Extra environment variables merged on top of `process.env` for the spawned shell process. */
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
  /**
   * Sandbox policy for the command.
   *
   * `useDefault` is the normal path. `requireEscalated` tells the adapter that
   * this command should be treated as sensitive and may require approval before
   * the native host runs it.
   *
   * Defaults to `useDefault`.
   */
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

/**
 * Normalized result returned by `exec()` and `writeToSession()`.
 *
 * This is the adapter-level shape you should expect in app code. It hides the
 * lower-level host protocol details and keeps the result stable whether the
 * command finished immediately or is still running in a PTY session.
 */
export interface CodexShellResult {
  /** Adapter session id, present when the command is still running under a PTY. */
  sessionId?: string
  /** Original command string that produced this result. */
  command: string
  /** Effective working directory used for the command. */
  cwd: string
  /** Exit code, present when the command has finished. */
  exitCode?: number
  /** True when the command is still running and can be resumed or written to. */
  running: boolean
  /** Aggregated output collected so far, possibly cropped to the configured output budget. */
  output: string
  /** The latest chunk returned by the host for this request. */
  latestChunk: string
}

/**
 * Persisted snapshot of a running or completed session held by the adapter.
 *
 * Sessions are created by `exec({ tty: true })` and then updated through
 * `writeToSession()`.
 */
export interface CodexShellSessionSnapshot extends CodexShellResult {
  /** Sandbox policy captured when the session was created. */
  sandboxPermissions: CodexShellSandboxPermissions
}

/**
 * Optional shell bridge assets used to patch shell exec behavior.
 *
 * The bridge is the extra native support layer that lets the host resolve and
 * launch shell commands in the same way the package expects. In practice it may
 * involve a patched shell binary plus a small exec wrapper so the host can
 * intercept command startup cleanly.
 *
 * You usually do not need to set this manually unless you are pinning custom
 * native builds, running from a nonstandard layout, or disabling the managed
 * bridge entirely.
 */
export interface CodexShellBridgeOptions {
  /**
   * Set to `false` to disable bridge setup even if packaged assets are
   * available.
   *
   * Use this when you want the native host to run without the additional shell
   * integration layer.
   */
  enabled?: boolean
  /**
   * Explicit path to the patched `zsh` binary.
   *
   * Provide this when you already built or installed the bridge shell binary
   * yourself and want the adapter to skip auto-discovery.
   */
  zshBinary?: string
  /**
   * Explicit path to the `codex-execve-wrapper` bridge binary.
   *
   * This wrapper is the helper the host uses to intercept exec calls and route
   * them through the sandbox-aware command startup path.
   */
  execveWrapperBinary?: string
}

/** Top-level configuration for `CodexShellAdapter`. All fields are optional. */
export interface CodexShellAdapterOptions {
  /**
   * Explicit path to `codex-sandbox-host`.
   *
   * Usually not needed. The adapter resolves packaged assets, ancestor repo
   * builds, environment overrides, and finally `PATH`.
   *
   * Set this when you want to pin one exact host binary instead of relying on
   * auto-discovery.
   */
  hostBinary?: string
  /**
   * Dedicated config directory used as `CODEX_HOME` for the native host.
   *
   * Defaults to `~/.codex-sandbox`.
   *
   * This is useful when you want isolated config state per project or test run.
   */
  configPath?: string
  /**
   * Default shell binary for commands.
   *
   * This is the shell the native host invokes when you do not override `shell`
   * per command.
   */
  shell?: string
  /**
   * Default command working directory and native asset search starting point.
   *
   * This value influences both where commands run and where the adapter begins
   * looking for repo-local native binaries.
   */
  cwd?: string
  /**
   * Extra environment variables passed to the native host process.
   *
   * These are merged into the child process environment for the host itself,
   * not just the shell command you eventually execute.
   */
  env?: NodeJS.ProcessEnv
  /**
   * Extra argv appended when spawning `codex-sandbox-host`.
   *
   * Use this only when you know the native host accepts additional CLI flags.
   */
  launchArgs?: string[]
  /**
   * Inline approval callback for guarded commands.
   *
   * This is where you choose between `accept`, `acceptForSession`,
   * `decline`, and `cancel`.
   *
   * The callback should return quickly and deterministically. It is part of the
   * approval path, so it should not itself start shell commands or wait on
   * interactive UI unless you intentionally want to block execution.
   */
  approvalResolver?: CodexShellApprovalResolver
  /**
   * Optional bridge overrides.
   *
   * Usually not needed when the package ships native assets or when the host
   * and bridge binaries are built in the repo.
   *
   * If you are not sure whether you need this, you probably do not. Leaving it
   * unset lets the adapter discover packaged assets, repo builds, and system
   * binaries automatically.
   */
  bridge?: CodexShellBridgeOptions
}
