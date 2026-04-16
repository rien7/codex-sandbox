import { randomUUID } from 'node:crypto'
import process from 'node:process'

import type { CodexShellNativeClient } from './client.js'
import { CodexShellHostClient } from './client.js'
import { getDefaultConfigPath } from './config-path.js'
import type {
  HostApprovalRequest,
  HostExecCommandParams,
  HostExecCommandResult,
  HostSandboxPermissions,
  HostWriteStdinParams,
} from './protocol.js'
import { resolveNativeShellBundle } from './resolver.js'
import { CodexShellSessionStore } from './session-store.js'
import type {
  CodexShellAdapterOptions,
  CodexShellApprovalContext,
  CodexShellApprovalDecision,
  CodexShellApprovalResolver,
  CodexShellExecInput,
  CodexShellResult,
  CodexShellSandboxPermissions,
  CodexShellSessionSnapshot,
  CodexShellWriteInput,
} from './types.js'

const defaultYieldTimeMs = 1_000

export interface CodexShellAdapterRuntime {
  /** Warm up the native host process without executing a command yet. */
  start: () => Promise<void>
  /** Shut down the native host process and clear any adapter-held session state. */
  close: () => Promise<void>
  /** Execute a shell command through the sandbox host. */
  exec: (input: CodexShellExecInput, signal?: AbortSignal) => Promise<CodexShellResult>
  /** Write bytes or text into a live PTY session started by `exec({ tty: true })`. */
  writeToSession: (input: CodexShellWriteInput, signal?: AbortSignal) => Promise<CodexShellResult>
  /** Ask the native host to terminate a live PTY session. */
  terminateSession: (sessionId: string) => Promise<void>
  /** Read a copy of the current session snapshot, if the session still exists. */
  getSessionSnapshot: (sessionId: string) => CodexShellSessionSnapshot | undefined
  /** List all known sessions tracked by the adapter. */
  listSessions: () => CodexShellSessionSnapshot[]
}

/** High-level TypeScript adapter over the native Codex shell host protocol. */
export class CodexShellAdapter implements CodexShellAdapterRuntime {
  private readonly options: CodexShellAdapterOptions
  private readonly sessions = new CodexShellSessionStore()
  /** Temporary lookup that ties a host approval request back to the command that triggered it. */
  private readonly approvalContexts = new Map<string, CodexShellApprovalContext>()
  /** Lazily created native client, reused across calls until `close()` is invoked. */
  private client: CodexShellNativeClient | undefined
  /** Memoized startup promise so parallel callers share one native host initialization. */
  private clientPromise: Promise<CodexShellNativeClient> | undefined
  /** Subscription handle for host-emitted approval notifications. */
  private approvalUnsubscribe: (() => void) | undefined

  constructor(options: CodexShellAdapterOptions = {}) {
    this.options = options
  }

  async start(): Promise<void> {
    // Force client creation so the host process is ready before the first command.
    await this.getClient()
  }

  async close(): Promise<void> {
    const client = this.client
    const approvalUnsubscribe = this.approvalUnsubscribe

    this.approvalUnsubscribe = undefined
    approvalUnsubscribe?.()

    if (!client) {
      // Nothing was started yet, so just clear memoized startup state.
      this.clientPromise = undefined
      this.approvalContexts.clear()
      return
    }

    // Best-effort cleanup: terminate any still-running PTY sessions before the host exits.
    await Promise.allSettled(this.sessions.values().filter(session => session.running).map(async (session) => {
      const sessionId = session.sessionId
      if (!sessionId) {
        return
      }

      const nativeSessionId = Number.parseInt(sessionId, 10)
      if (!Number.isNaN(nativeSessionId)) {
        await client.terminateSession({ sessionId: nativeSessionId })
      }
    }))
    await client.shutdown()

    this.client = undefined
    this.clientPromise = undefined
    this.approvalContexts.clear()
  }

  async exec(input: CodexShellExecInput, signal?: AbortSignal): Promise<CodexShellResult> {
    if (!input.cmd.trim()) {
      throw new Error('exec requires a non-empty cmd string.')
    }

    const client = await this.getClient()
    const itemId = randomUUID()
    const normalized = normalizeExecInput(this.options, input)
    // Store request-scoped context long enough for the host's approval callback to arrive.
    const approvalContext: CodexShellApprovalContext = {
      itemId,
      sandboxPermissions: normalized.sandboxPermissions,
    }
    const result = await this.runWithApprovalContext(approvalContext, () => (
      client.exec(this.buildExecParams(normalized, itemId), signal)
    ))

    return this.consumeExecResult(normalized, result)
  }

  async writeToSession(input: CodexShellWriteInput, signal?: AbortSignal): Promise<CodexShellResult> {
    const session = this.sessions.get(input.sessionId)
    if (!session) {
      throw new TypeError(`Unknown shell session "${input.sessionId}".`)
    }

    const sessionId = session.sessionId
    if (!sessionId) {
      throw new TypeError(`Shell session "${input.sessionId}" does not have a native process id.`)
    }

    const nativeSessionId = Number.parseInt(sessionId, 10)
    if (Number.isNaN(nativeSessionId)) {
      throw new TypeError(`Shell session "${input.sessionId}" has an invalid native process id.`)
    }

    const client = await this.getClient()
    const itemId = randomUUID()
    // Reuse the original session's sandbox policy when the PTY session is extended.
    const approvalContext: CodexShellApprovalContext = {
      itemId,
      sandboxPermissions: session.sandboxPermissions,
    }
    const result = await this.runWithApprovalContext(approvalContext, () => (
      client.writeToSession(this.buildWriteParams(input, itemId, nativeSessionId), signal)
    ))

    const updatedSession = this.sessions.appendResult(sessionId, result)
    if (!updatedSession) {
      throw new Error(`Shell session "${input.sessionId}" disappeared during update.`)
    }

    return { ...updatedSession }
  }

  async terminateSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      return
    }

    const nativeSessionId = Number.parseInt(session.sessionId ?? '', 10)
    if (Number.isNaN(nativeSessionId)) {
      return
    }

    const client = await this.getClient()
    await client.terminateSession({ sessionId: nativeSessionId })
    this.sessions.delete(sessionId)
  }

  getSessionSnapshot(sessionId: string): CodexShellSessionSnapshot | undefined {
    const session = this.sessions.get(sessionId)
    return session ? { ...session } : undefined
  }

  listSessions(): CodexShellSessionSnapshot[] {
    return this.sessions.values().map(session => ({ ...session }))
  }

  private async getClient(): Promise<CodexShellNativeClient> {
    if (!this.clientPromise) {
      // Only the first caller constructs the client; others await the same promise.
      this.clientPromise = this.createClient()
    }

    return this.clientPromise
  }

  private async createClient(): Promise<CodexShellNativeClient> {
    // Resolve the native host and optional bridge assets from explicit config,
    // environment overrides, packaged binaries, repo builds, or PATH.
    const resolution = resolveNativeShellBundle({
      ...(this.options.hostBinary ? { hostBinary: this.options.hostBinary } : {}),
      ...(this.options.bridge?.zshBinary ? { zshBinary: this.options.bridge.zshBinary } : {}),
      ...(this.options.bridge?.execveWrapperBinary
        ? { execveWrapperBinary: this.options.bridge.execveWrapperBinary }
        : {}),
      ...(this.options.env ? { env: this.options.env } : {}),
      ...(this.options.cwd ? { cwd: this.options.cwd } : {}),
    })
    if (!resolution) {
      throw new Error('Could not resolve a native sandbox host binary. Set CODEX_SANDBOX_HOST_BINARY or provide hostBinary.')
    }

    // The low-level host client owns one native process and speaks JSON-RPC over stdio.
    const client = new CodexShellHostClient({
      binaryPath: resolution.hostBinary.binaryPath,
      configPath: this.options.configPath ?? getDefaultConfigPath(),
      ...(this.options.bridge?.enabled === false || !resolution.bridge ? {} : { bridge: resolution.bridge }),
      ...(this.options.launchArgs ? { launchArgs: this.options.launchArgs } : {}),
      ...(this.options.cwd ? { cwd: this.options.cwd } : {}),
      ...(this.options.env ? { env: this.options.env } : {}),
    })

    await client.start()
    // Register the approval listener only after the host is running.
    this.approvalUnsubscribe = client.onApprovalRequest((event) => {
      void this.handleApprovalRequest(event)
    })
    this.client = client
    return client
  }

  private buildExecParams(input: NormalizedExecInput, itemId: string): HostExecCommandParams {
    // Convert the adapter-level exec input into the raw host protocol shape.
    return {
      itemId,
      cmd: input.cmd,
      cwd: input.cwd,
      tty: input.tty,
      login: input.login,
      shell: input.shell,
      yieldTimeMs: input.yieldTimeMs,
      sandboxPermissions: toHostSandboxPermissions(input.sandboxPermissions),
      ...(input.env ? { env: input.env } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.maxOutputTokens !== undefined ? { maxOutputTokens: input.maxOutputTokens } : {}),
    }
  }

  private buildWriteParams(
    input: CodexShellWriteInput,
    itemId: string,
    sessionId: number,
  ): HostWriteStdinParams {
    // `writeToSession()` only needs stdin bytes and a session target.
    return {
      itemId,
      sessionId,
      yieldTimeMs: input.yieldTimeMs ?? defaultYieldTimeMs,
      ...(input.chars !== undefined ? { chars: input.chars } : {}),
      ...(input.maxOutputTokens !== undefined ? { maxOutputTokens: input.maxOutputTokens } : {}),
    }
  }

  private consumeExecResult(input: NormalizedExecInput, result: HostExecCommandResult): CodexShellResult {
    // If the host returned a session id without an exit code, the command is still running.
    if (result.sessionId && result.exitCode === undefined) {
      const session = this.sessions.createRunningSession({
        sessionId: result.sessionId,
        command: input.cmd,
        cwd: input.cwd,
        sandboxPermissions: input.sandboxPermissions,
        initialChunk: result.output,
      })
      return { ...session }
    }

    // Otherwise normalize the host's one-shot result into the higher-level adapter shape.
    return {
      command: input.cmd,
      cwd: input.cwd,
      running: false,
      output: cropOutput(result.output, input.maxOutputTokens),
      latestChunk: result.output,
      ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
    }
  }

  private async runWithApprovalContext<TValue>(
    context: CodexShellApprovalContext,
    run: () => Promise<TValue>,
  ): Promise<TValue> {
    // The map entry exists only while the host may still emit an approval request.
    this.approvalContexts.set(context.itemId, context)
    try {
      return await run()
    }
    finally {
      this.approvalContexts.delete(context.itemId)
    }
  }

  private async handleApprovalRequest(request: HostApprovalRequest): Promise<void> {
    const client = this.client
    if (!client) {
      return
    }

    // Look up the request metadata that was captured when the command started.
    const context = this.approvalContexts.get(request.itemId)
    const decision = await resolveApprovalDecision(this.options.approvalResolver, request, context)
    await client.respondToApproval({
      approvalId: request.approvalId,
      decision,
    })
  }
}

interface NormalizedExecInput extends Required<Pick<CodexShellExecInput, 'cmd'>> {
  cwd: string
  env?: Record<string, string>
  timeoutMs?: number
  yieldTimeMs: number
  maxOutputTokens?: number
  tty: boolean
  login: boolean
  shell: string
  sandboxPermissions: NonNullable<CodexShellExecInput['sandboxPermissions']>
}

function normalizeExecInput(
  options: CodexShellAdapterOptions,
  input: CodexShellExecInput,
): NormalizedExecInput {
  return {
    cmd: input.cmd,
    cwd: input.cwd ?? options.cwd ?? process.cwd(),
    ...(input.env ? { env: input.env } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    yieldTimeMs: input.yieldTimeMs ?? defaultYieldTimeMs,
    ...(input.maxOutputTokens !== undefined ? { maxOutputTokens: input.maxOutputTokens } : {}),
    tty: input.tty ?? false,
    login: input.login ?? true,
    shell: input.shell ?? options.shell ?? getDefaultShell(),
    sandboxPermissions: input.sandboxPermissions ?? 'useDefault',
  }
}

async function resolveApprovalDecision(
  resolver: CodexShellApprovalResolver | undefined,
  request: HostApprovalRequest,
  context: CodexShellApprovalContext | undefined,
): Promise<CodexShellApprovalDecision> {
  if (resolver) {
    const decision = await resolver(request, context)
    return coerceApprovalDecision(decision, request.availableDecisions, context)
  }

  return defaultApprovalDecision(request.availableDecisions, context)
}

function toHostSandboxPermissions(value: CodexShellSandboxPermissions): HostSandboxPermissions {
  // The host protocol currently uses the same two symbolic values.
  return value === 'requireEscalated' ? 'requireEscalated' : 'useDefault'
}

function cropOutput(value: string, maxOutputTokens?: number): string {
  if (!maxOutputTokens || maxOutputTokens <= 0) {
    return value
  }

  const maxChars = Math.max(200, maxOutputTokens * 4)
  if (value.length <= maxChars) {
    return value
  }

  return value.slice(value.length - maxChars)
}

function coerceApprovalDecision(
  requested: CodexShellApprovalDecision,
  availableDecisions: CodexShellApprovalDecision[] | undefined,
  context: CodexShellApprovalContext | undefined,
): CodexShellApprovalDecision {
  if (isDecisionAllowed(requested, availableDecisions)) {
    return requested
  }

  return defaultApprovalDecision(availableDecisions, context)
}

function defaultApprovalDecision(
  availableDecisions: CodexShellApprovalDecision[] | undefined,
  context: CodexShellApprovalContext | undefined,
): CodexShellApprovalDecision {
  // When no resolver is provided, choose the least surprising allowed decision.
  const preferred: CodexShellApprovalDecision[] = context?.sandboxPermissions === 'requireEscalated'
    ? ['acceptForSession', 'accept', 'decline', 'cancel']
    : ['decline', 'cancel', 'accept', 'acceptForSession']

  for (const decision of preferred) {
    if (isDecisionAllowed(decision, availableDecisions)) {
      return decision
    }
  }

  return 'cancel'
}

function isDecisionAllowed(
  decision: CodexShellApprovalDecision,
  availableDecisions: CodexShellApprovalDecision[] | undefined,
): boolean {
  return !availableDecisions || availableDecisions.includes(decision)
}

function getDefaultShell(): string {
  // Match common shell resolution order without forcing callers to configure it.
  if (process.env.SHELL) {
    return process.env.SHELL
  }

  if (process.platform === 'win32') {
    return process.env.ComSpec ?? 'powershell.exe'
  }

  return '/bin/zsh'
}
