/**
 * JSON-RPC request/response id used by the native stdio protocol.
 *
 * The host may use either numeric or string ids depending on the request path.
 */
export type JsonRpcId = number | string

/**
 * Standard JSON-RPC error shape returned by the native host.
 *
 * `data` is intentionally opaque because different host errors may attach
 * different structured payloads.
 */
export interface JsonRpcErrorShape {
  code: number
  message: string
  data?: unknown
}

/**
 * Generic JSON-RPC response envelope used by the native host client.
 *
 * The adapter only cares about the fields it needs to match a pending request.
 */
export interface JsonRpcResponse<TResult = unknown> {
  id?: JsonRpcId
  result?: TResult
  error?: JsonRpcErrorShape
}

/**
 * Low-level sandbox mode sent to the native host.
 *
 * This is the protocol-level counterpart to `CodexShellSandboxPermissions`.
 */
export type HostSandboxPermissions = 'useDefault' | 'requireEscalated'

/**
 * Low-level approval decisions accepted by the native host.
 *
 * Semantics:
 * - `accept`: run only this request
 * - `acceptForSession`: remember approval for the current host process
 * - `decline`: reject execution
 * - `cancel`: abort without approval
 */
export type HostApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel'

/**
 * Response returned by the host `initialize` request.
 *
 * The adapter uses this as a lightweight compatibility check when the child
 * process starts.
 */
export interface HostInitializeResponse {
  userAgent: string
  platformFamily: string
  platformOs: string
}

/**
 * Raw `command/exec` payload sent to the native host.
 *
 * This is the exact shape written over stdio before the host decides whether
 * the command can run immediately or needs approval.
 */
export interface HostExecCommandParams {
  /** Adapter-generated request id used to correlate stdout, approval, and results. */
  itemId: string
  /** Shell command to execute. */
  cmd: string
  /** Working directory for the command. */
  cwd: string
  /** Optional environment overrides merged into the command process. */
  env?: Record<string, string>
  /** Optional hard timeout for non-interactive execution. */
  timeoutMs?: number
  /** Whether the command should be started under a PTY. */
  tty: boolean
  /** Whether to use a login shell. */
  login: boolean
  /** Shell binary to launch. */
  shell: string
  /** How long the host should wait before yielding a partial output chunk. */
  yieldTimeMs: number
  /** Optional output budget applied by the host. */
  maxOutputTokens?: number
  /** Sandbox policy requested for this command. */
  sandboxPermissions: HostSandboxPermissions
}

/**
 * Raw `command/writeStdin` payload sent to the native host.
 *
 * This is only used for interactive PTY sessions that are still running.
 */
export interface HostWriteStdinParams {
  /** Adapter-generated request id used to correlate this write with a session. */
  itemId: string
  /** Native host session id. */
  sessionId: number
  /** Text or bytes to forward to stdin. */
  chars?: string
  /** How long the host should wait for output before returning. */
  yieldTimeMs: number
  /** Optional output budget applied by the host. */
  maxOutputTokens?: number
}

/** Raw `command/terminate` payload sent to the native host. */
export interface HostTerminateParams {
  /** Native host session id. */
  sessionId: number
}

/**
 * Raw `approval/respond` payload sent to the native host.
 *
 * The adapter returns exactly one decision per approval prompt using this
 * payload.
 */
export interface HostApprovalResponseParams {
  /** Host-generated approval id from the corresponding approval request. */
  approvalId: string
  /** Decision selected by the adapter-level approval resolver. */
  decision: HostApprovalDecision
}

/**
 * Raw exec result returned by the native host.
 *
 * The presence of `sessionId` without `exitCode` usually means the command is
 * running in a PTY and can be written to later.
 */
export interface HostExecCommandResult {
  /** Adapter-generated request id echoed back by the host. */
  itemId: string
  /** Native host session id, when the command is still running. */
  sessionId?: string
  /** Exit code for completed commands. */
  exitCode?: number
  /** Latest output chunk captured by the host. */
  output: string
  /** Host-local chunk identifier. */
  chunkId: string
  /** Wall-clock duration reported by the host. */
  wallTimeMs: number
}

/**
 * Approval notification emitted by the native host.
 *
 * `availableDecisions` indicates which choices the caller may return when
 * responding through `approval/respond`.
 */
export interface HostApprovalRequest {
  itemId: string
  approvalId: string
  command?: string
  cwd?: string
  reason?: string
  availableDecisions?: HostApprovalDecision[]
}

/** Check whether a parsed line matches the host JSON-RPC response envelope. */
export function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
  if (!value || typeof value !== 'object') {
    return false
  }

  return 'result' in value || 'error' in value
}
