/** JSON-RPC request/response id used by the native stdio protocol. */
export type JsonRpcId = number | string

/** Standard JSON-RPC error shape returned by the native host. */
export interface JsonRpcErrorShape {
  code: number
  message: string
  data?: unknown
}

/** Generic JSON-RPC response envelope used by the native host client. */
export interface JsonRpcResponse<TResult = unknown> {
  id?: JsonRpcId
  result?: TResult
  error?: JsonRpcErrorShape
}

/** Low-level sandbox mode sent to the native host. */
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

/** Response returned by the host `initialize` request. */
export interface HostInitializeResponse {
  userAgent: string
  platformFamily: string
  platformOs: string
}

/** Raw `command/exec` payload sent to the native host. */
export interface HostExecCommandParams {
  itemId: string
  cmd: string
  cwd: string
  env?: Record<string, string>
  timeoutMs?: number
  tty: boolean
  login: boolean
  shell: string
  yieldTimeMs: number
  maxOutputTokens?: number
  sandboxPermissions: HostSandboxPermissions
}

/** Raw `command/writeStdin` payload sent to the native host. */
export interface HostWriteStdinParams {
  itemId: string
  sessionId: number
  chars?: string
  yieldTimeMs: number
  maxOutputTokens?: number
}

/** Raw `command/terminate` payload sent to the native host. */
export interface HostTerminateParams {
  sessionId: number
}

/** Raw `approval/respond` payload sent to the native host. */
export interface HostApprovalResponseParams {
  approvalId: string
  decision: HostApprovalDecision
}

/** Raw exec result returned by the native host. */
export interface HostExecCommandResult {
  itemId: string
  sessionId?: string
  exitCode?: number
  output: string
  chunkId: string
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
