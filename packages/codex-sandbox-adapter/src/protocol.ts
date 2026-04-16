export type JsonRpcId = number | string

export interface JsonRpcErrorShape {
  code: number
  message: string
  data?: unknown
}

export interface JsonRpcResponse<TResult = unknown> {
  id?: JsonRpcId
  result?: TResult
  error?: JsonRpcErrorShape
}

export type HostSandboxPermissions = 'useDefault' | 'requireEscalated'

export type HostApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel'

export interface HostInitializeResponse {
  userAgent: string
  platformFamily: string
  platformOs: string
}

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

export interface HostWriteStdinParams {
  itemId: string
  sessionId: number
  chars?: string
  yieldTimeMs: number
  maxOutputTokens?: number
}

export interface HostTerminateParams {
  sessionId: number
}

export interface HostApprovalResponseParams {
  approvalId: string
  decision: HostApprovalDecision
}

export interface HostExecCommandResult {
  itemId: string
  sessionId?: string
  exitCode?: number
  output: string
  chunkId: string
  wallTimeMs: number
}

export interface HostApprovalRequest {
  itemId: string
  approvalId: string
  command?: string
  cwd?: string
  reason?: string
  availableDecisions?: HostApprovalDecision[]
}

export function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
  if (!value || typeof value !== 'object') {
    return false
  }

  return 'result' in value || 'error' in value
}
