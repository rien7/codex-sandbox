import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import process from 'node:process'
import { createInterface } from 'node:readline'

import { prepareCodexHome } from './codex-home.js'
import type {
  HostApprovalRequest,
  HostApprovalResponseParams,
  HostExecCommandParams,
  HostExecCommandResult,
  HostInitializeResponse,
  HostTerminateParams,
  HostWriteStdinParams,
  JsonRpcErrorShape,
  JsonRpcId,
} from './protocol.js'
import { isJsonRpcResponse } from './protocol.js'
import type { NativeShellBridgeResolution } from './resolver.js'

const lineSplitPattern = /\r?\n/u

export interface CodexShellNativeClient {
  start: () => Promise<void>
  shutdown: () => Promise<void>
  exec: (params: HostExecCommandParams, signal?: AbortSignal) => Promise<HostExecCommandResult>
  writeToSession: (
    params: HostWriteStdinParams,
    signal?: AbortSignal,
  ) => Promise<HostExecCommandResult>
  terminateSession: (params: HostTerminateParams) => Promise<void>
  respondToApproval: (params: HostApprovalResponseParams) => Promise<void>
  onApprovalRequest: (listener: (event: HostApprovalRequest) => void) => () => void
}

export interface CodexShellHostClientOptions {
  binaryPath: string
  codexHome: string
  bridge?: NativeShellBridgeResolution
  launchArgs?: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
}

/** Own one native sandbox host process and route JSON-RPC requests over stdio. */
export class CodexShellHostClient implements CodexShellNativeClient {
  private readonly options: CodexShellHostClientOptions
  private readonly approvalEvents = new EventEmitter()
  private readonly pendingRequests = new Map<JsonRpcId, {
    resolve: (value: unknown) => void
    reject: (reason: unknown) => void
  }>()

  private child: ReturnType<typeof spawn> | undefined
  private initializePromise: Promise<void> | undefined
  private nextRequestId = 1
  private stderrLines: string[] = []

  constructor(options: CodexShellHostClientOptions) {
    this.options = options
  }

  async start(): Promise<void> {
    if (!this.initializePromise) {
      this.initializePromise = this.startInternal()
    }

    await this.initializePromise
  }

  async shutdown(): Promise<void> {
    const child = this.child
    this.child = undefined
    this.initializePromise = undefined

    for (const pending of this.pendingRequests.values()) {
      pending.reject(new Error('Codex sandbox host shut down before a response arrived.'))
    }
    this.pendingRequests.clear()

    if (!child) {
      return
    }

    child.kill('SIGTERM')
  }

  async exec(params: HostExecCommandParams, signal?: AbortSignal): Promise<HostExecCommandResult> {
    await this.start()
    return this.sendRequest('command/exec', params, signal) as Promise<HostExecCommandResult>
  }

  async writeToSession(
    params: HostWriteStdinParams,
    signal?: AbortSignal,
  ): Promise<HostExecCommandResult> {
    await this.start()
    return this.sendRequest('command/writeStdin', params, signal) as Promise<HostExecCommandResult>
  }

  async terminateSession(params: HostTerminateParams): Promise<void> {
    await this.start()
    await this.sendRequest('command/terminate', params)
  }

  async respondToApproval(params: HostApprovalResponseParams): Promise<void> {
    await this.start()
    await this.sendRequest('approval/respond', params)
  }

  onApprovalRequest(listener: (event: HostApprovalRequest) => void): () => void {
    this.approvalEvents.on('approval', listener)
    return () => {
      this.approvalEvents.off('approval', listener)
    }
  }

  private async startInternal(): Promise<void> {
    await prepareCodexHome({
      codexHome: this.options.codexHome,
      ...(this.options.bridge ? { bridge: this.options.bridge } : {}),
    })

    const child = spawn(this.options.binaryPath, this.options.launchArgs ?? [], {
      cwd: this.options.cwd ?? process.cwd(),
      env: {
        ...process.env,
        ...this.options.env,
        CODEX_HOME: this.options.codexHome,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    this.child = child
    this.stderrLines = []

    child.once('exit', (_code, signal) => {
      this.child = undefined
      const message = signal
        ? `Codex sandbox host exited from signal ${signal}.`
        : this.stderrLines.length > 0
          ? `Codex sandbox host exited. Last stderr: ${this.stderrLines.at(-1)}`
          : 'Codex sandbox host exited.'

      for (const pending of this.pendingRequests.values()) {
        pending.reject(new Error(message))
      }
      this.pendingRequests.clear()
    })

    const stderr = requireDefinedStream(child.stderr, 'stderr')
    stderr.setEncoding('utf8')
    stderr.on('data', (chunk: string) => {
      for (const line of chunk.split(lineSplitPattern)) {
        if (!line.trim()) {
          continue
        }

        this.stderrLines.push(line)
        if (this.stderrLines.length > 20) {
          this.stderrLines.shift()
        }
      }
    })

    const stdout = createInterface({
      input: requireDefinedStream(child.stdout, 'stdout'),
      crlfDelay: Number.POSITIVE_INFINITY,
    })
    stdout.on('line', line => this.handleStdoutLine(line))

    const initializeResponse = await this.sendRequest<HostInitializeResponse>('initialize', {})
    if (!initializeResponse.userAgent) {
      throw new Error('Codex sandbox host initialize response is missing userAgent.')
    }
  }

  private handleStdoutLine(line: string): void {
    if (!line.trim()) {
      return
    }

    const message = JSON.parse(line) as unknown
    if (isJsonRpcResponse(message)) {
      if (message.id === undefined) {
        return
      }

      const pending = this.pendingRequests.get(message.id)
      if (!pending) {
        return
      }

      this.pendingRequests.delete(message.id)
      if (message.error) {
        pending.reject(new Error(formatJsonRpcError(message.error)))
        return
      }

      pending.resolve(message.result)
      return
    }

    if (isApprovalRequestNotification(message)) {
      this.approvalEvents.emit('approval', message.params)
    }
  }

  private async sendRequest<TResult = unknown>(
    method: string,
    params: unknown,
    signal?: AbortSignal,
  ): Promise<TResult> {
    const child = this.child
    if (!child) {
      throw new Error('Codex sandbox host is not running.')
    }

    const id = this.nextRequestId++
    const payload = { id, method, params }
    const promise = new Promise<TResult>((resolve, reject) => {
      this.pendingRequests.set(id, {
        resolve: value => resolve(value as TResult),
        reject,
      })
    })

    if (signal) {
      signal.addEventListener('abort', () => {
        const pending = this.pendingRequests.get(id)
        if (!pending) {
          return
        }

        this.pendingRequests.delete(id)
        pending.reject(signal.reason ?? new Error('Request aborted.'))
      }, { once: true })
    }

    requireDefinedStream(child.stdin, 'stdin').write(`${JSON.stringify(payload)}\n`)
    return promise
  }
}

function formatJsonRpcError(error: JsonRpcErrorShape): string {
  return `${error.message} (code ${error.code})`
}

function requireDefinedStream<TValue>(value: TValue | null, name: string): TValue {
  if (value === null) {
    throw new Error(`Codex sandbox host ${name} stream is not available.`)
  }

  return value
}

function isApprovalRequestNotification(
  value: unknown,
): value is { method: 'item/commandExecution/requestApproval', params: HostApprovalRequest } {
  if (!value || typeof value !== 'object') {
    return false
  }

  return 'method' in value
    && value.method === 'item/commandExecution/requestApproval'
    && 'params' in value
}
