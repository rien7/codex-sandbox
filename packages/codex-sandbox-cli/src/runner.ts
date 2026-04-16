import { createReadStream, createWriteStream, existsSync, openSync } from 'node:fs'
import process from 'node:process'
import { createInterface } from 'node:readline/promises'
import { parseArgs } from 'node:util'

import { CodexShellAdapter } from '@rien7/codex-sandbox'
import type {
  CodexShellAdapterOptions,
  CodexShellApprovalContext,
  CodexShellApprovalDecision,
  CodexShellApprovalRequest,
  CodexShellExecInput,
  CodexShellResult,
  CodexShellSandboxPermissions,
  CodexShellWriteInput,
} from '@rien7/codex-sandbox'

export interface RunCliOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  stdin?: NodeJS.ReadStream
  stdout?: NodeJS.WriteStream
  stderr?: NodeJS.WriteStream
  prompt?: (
    request: CodexShellApprovalRequest,
    context: CodexShellApprovalContext | undefined,
  ) => Promise<CodexShellApprovalDecision> | CodexShellApprovalDecision
}

/** Run the sandbox CLI and return the process exit code. */
export async function runCli(argv: string[], options: RunCliOptions = {}): Promise<number> {
  const stdin = options.stdin ?? process.stdin
  const stdout = options.stdout ?? process.stdout
  const stderr = options.stderr ?? process.stderr

  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      cmd: { type: 'string' },
      'config-path': { type: 'string' },
      cwd: { type: 'string' },
      'execve-wrapper-binary': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      'host-binary': { type: 'string' },
      json: { type: 'boolean' },
      'max-output-tokens': { type: 'string' },
      sandbox: { type: 'string' },
      shell: { type: 'string' },
      tty: { type: 'boolean' },
      'timeout-ms': { type: 'string' },
      'yield-ms': { type: 'string' },
      'zsh-binary': { type: 'string' },
    },
  })

  const command = positionals[0]
  if (!command || command === 'help' || values.help) {
    stdout.write(`${buildHelpText()}\n`)
    return 0
  }

  const adapter = new CodexShellAdapter(createAdapterOptions({
    stderr,
    stdin,
    stdout,
    ...(values.cwd ?? options.cwd ? { cwd: values.cwd ?? options.cwd } : {}),
    ...(options.env ? { env: options.env } : {}),
    ...(values['execve-wrapper-binary'] ? { execveWrapperBinary: values['execve-wrapper-binary'] } : {}),
    ...(values['host-binary'] ? { hostBinary: values['host-binary'] } : {}),
    ...(options.prompt ? { prompt: options.prompt } : {}),
    ...(values.shell ? { shell: values.shell } : {}),
    ...(values['zsh-binary'] ? { zshBinary: values['zsh-binary'] } : {}),
    ...(values['config-path'] ? { configPath: values['config-path'] } : {}),
  }))

  try {
    if (command === 'smoke') {
      const sandboxPermissions = parseSandboxPermissions(values.sandbox)
      const result = await adapter.exec(createExecInput({
        cmd: values.cmd ?? 'printf codex-sandbox-ok',
        tty: false,
        ...(sandboxPermissions ? { sandboxPermissions } : {}),
      }))
      return renderResult(result, Boolean(values.json), stdout)
    }

    if (command === 'exec') {
      const cmd = values.cmd
      if (!cmd) {
        throw new TypeError('exec requires --cmd.')
      }

      const sandboxPermissions = parseSandboxPermissions(values.sandbox)
      const timeoutMs = parseOptionalNumber(values['timeout-ms'], '--timeout-ms')
      const yieldTimeMs = parseOptionalNumber(values['yield-ms'], '--yield-ms')
      const maxOutputTokens = parseOptionalNumber(values['max-output-tokens'], '--max-output-tokens')
      const result = await adapter.exec(createExecInput({
        cmd,
        tty: Boolean(values.tty),
        ...(values.cwd ? { cwd: values.cwd } : {}),
        ...(values.shell ? { shell: values.shell } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(yieldTimeMs !== undefined ? { yieldTimeMs } : {}),
        ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
        ...(sandboxPermissions ? { sandboxPermissions } : {}),
      }))

      if (!result.running) {
        return renderResult(result, Boolean(values.json), stdout)
      }

      if (Boolean(values.json)) {
        stdout.write(`${JSON.stringify(result, null, 2)}\n`)
        return 0
      }

      return runInteractiveSession({
        adapter,
        initialResult: result,
        pollInterval: result.running ? (yieldTimeMs ?? 1_000) : 1_000,
        stdin,
        stdout,
      })
    }

    throw new TypeError(`Unknown command "${command}".`)
  }
  finally {
    await adapter.close()
  }
}

async function runInteractiveSession(input: {
  adapter: CodexShellAdapter
  initialResult: CodexShellResult
  pollInterval: number
  stdin: NodeJS.ReadStream
  stdout: NodeJS.WriteStream
}): Promise<number> {
  if (input.initialResult.latestChunk) {
    input.stdout.write(input.initialResult.latestChunk)
  }

  const sessionId = input.initialResult.sessionId
  if (!sessionId) {
    return 1
  }

  let closed = false
  let exitCode = 0
  let queue = Promise.resolve<void>(undefined)

  const onChunk = (next: CodexShellResult): void => {
    if (next.latestChunk) {
      input.stdout.write(next.latestChunk)
    }

    if (!next.running) {
      closed = true
      exitCode = next.exitCode ?? 0
    }
  }

  const scheduleWrite = (chars: string | undefined): void => {
    queue = queue.then(async () => {
      if (closed) {
        return
      }

      const next = await input.adapter.writeToSession(createWriteInput({
        sessionId,
        yieldTimeMs: input.pollInterval,
        ...(chars !== undefined ? { chars } : {}),
      }))
      onChunk(next)
    }).catch((error) => {
      closed = true
      throw error
    })
  }

  input.stdin.setEncoding('utf8')
  input.stdin.on('data', (chunk: string) => {
    scheduleWrite(chunk)
  })
  input.stdin.resume()

  const pollTimer = setInterval(() => {
    if (!closed) {
      scheduleWrite(undefined)
    }
  }, input.pollInterval)

  try {
    for (;;) {
      if (closed) {
        break
      }

      await queue
      if (closed) {
        break
      }

      await delay(25)
    }
  }
  finally {
    clearInterval(pollTimer)
  }

  return exitCode
}

function renderResult(result: CodexShellResult, asJson: boolean, stdout: NodeJS.WriteStream): number {
  if (asJson) {
    stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  }
  else if (result.output) {
    stdout.write(result.output)
    if (!result.output.endsWith('\n')) {
      stdout.write('\n')
    }
  }

  return result.exitCode ?? 0
}

function createAdapterOptions(input: {
  configPath?: string
  cwd?: string
  env?: NodeJS.ProcessEnv
  execveWrapperBinary?: string
  hostBinary?: string
  prompt?: RunCliOptions['prompt']
  shell?: string
  stderr: NodeJS.WriteStream
  stdin: NodeJS.ReadStream
  stdout: NodeJS.WriteStream
  zshBinary?: string
}): CodexShellAdapterOptions {
  const bridge = createBridgeOptions(input)
  const approvalResolver = createApprovalResolver(input)

  return {
    ...(input.hostBinary ? { hostBinary: input.hostBinary } : {}),
    ...(input.configPath ? { configPath: input.configPath } : {}),
    ...(input.shell ? { shell: input.shell } : {}),
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(input.env ? { env: input.env } : {}),
    ...(approvalResolver ? { approvalResolver } : {}),
    ...(bridge ? { bridge } : {}),
  }
}

function createBridgeOptions(input: {
  execveWrapperBinary?: string
  zshBinary?: string
}): CodexShellAdapterOptions['bridge'] {
  if (!input.zshBinary && !input.execveWrapperBinary) {
    return undefined
  }

  return {
    ...(input.zshBinary ? { zshBinary: input.zshBinary } : {}),
    ...(input.execveWrapperBinary ? { execveWrapperBinary: input.execveWrapperBinary } : {}),
  }
}

function createApprovalResolver(input: {
  prompt?: RunCliOptions['prompt']
  stderr: NodeJS.WriteStream
  stdin: NodeJS.ReadStream
  stdout: NodeJS.WriteStream
}): CodexShellAdapterOptions['approvalResolver'] {
  return async (request, context) => {
    if (input.prompt) {
      return input.prompt(request, context)
    }

    return promptForApproval(request, context, {
      fallbackInput: input.stdin,
      fallbackOutput: input.stderr,
      stdout: input.stdout,
    })
  }
}

async function promptForApproval(
  request: CodexShellApprovalRequest,
  context: CodexShellApprovalContext | undefined,
  input: {
    fallbackInput: NodeJS.ReadStream
    fallbackOutput: NodeJS.WriteStream
    stdout: NodeJS.WriteStream
  },
): Promise<CodexShellApprovalDecision> {
  const availableDecisions = request.availableDecisions ?? ['accept', 'acceptForSession', 'decline', 'cancel']
  const defaultDecision = availableDecisions.includes('acceptForSession')
    ? 'acceptForSession'
    : availableDecisions[0]
  if (!defaultDecision) {
    return 'cancel'
  }

  const tty = openPromptTty(input.fallbackInput, input.fallbackOutput)
  const promptInput = tty?.input ?? input.fallbackInput
  const promptOutput = tty?.output ?? input.fallbackOutput
  const readline = createInterface({
    input: promptInput,
    output: promptOutput,
  })

  try {
    const lines = [
      '',
      '[codex-sandbox] approval required',
      `command: ${request.command ?? '<unknown>'}`,
      `cwd: ${request.cwd ?? '<unknown>'}`,
      ...(request.reason ? [`reason: ${request.reason}`] : []),
      ...(context ? [`sandbox: ${context.sandboxPermissions}`] : []),
      '',
      ...availableDecisions.map((decision: CodexShellApprovalDecision, index: number) => (
        `  ${index + 1}. ${decision}${decision === defaultDecision ? ' (default)' : ''}`
      )),
      '',
    ]
    promptOutput.write(`${lines.join('\n')}\n`)

    for (;;) {
      const answer = await readline.question(`Select decision [${defaultDecision}]: `)
      const normalized = answer.trim()
      if (!normalized) {
        return defaultDecision
      }

      const numericIndex = Number.parseInt(normalized, 10)
      if (!Number.isNaN(numericIndex)) {
        const selected = availableDecisions[numericIndex - 1]
        if (selected) {
          return selected
        }
      }

      if (availableDecisions.includes(normalized as CodexShellApprovalDecision)) {
        return normalized as CodexShellApprovalDecision
      }

      promptOutput.write(`Unknown choice "${normalized}". Try again.\n`)
    }
  }
  finally {
    readline.close()
    if (tty) {
      tty.input.destroy()
      tty.output.destroy()
    }
  }
}

function openPromptTty(
  fallbackInput: NodeJS.ReadStream,
  fallbackOutput: NodeJS.WriteStream,
): { input: NodeJS.ReadStream, output: NodeJS.WriteStream } | undefined {
  if (process.platform === 'win32') {
    return undefined
  }

  const ttyPath = '/dev/tty'
  if (!existsSync(ttyPath)) {
    return undefined
  }

  try {
    const inputFd = openSync(ttyPath, 'r')
    const outputFd = openSync(ttyPath, 'w')

    return {
      input: createReadStream('', { fd: inputFd, autoClose: true }) as unknown as NodeJS.ReadStream,
      output: createWriteStream('', { fd: outputFd, autoClose: true }) as unknown as NodeJS.WriteStream,
    }
  }
  catch {
    return undefined
  }
}

function createExecInput(input: {
  cmd: string
  cwd?: string
  maxOutputTokens?: number
  sandboxPermissions?: CodexShellSandboxPermissions
  shell?: string
  timeoutMs?: number
  tty: boolean
  yieldTimeMs?: number
}): CodexShellExecInput {
  return {
    cmd: input.cmd,
    tty: input.tty,
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(input.shell ? { shell: input.shell } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.yieldTimeMs !== undefined ? { yieldTimeMs: input.yieldTimeMs } : {}),
    ...(input.maxOutputTokens !== undefined ? { maxOutputTokens: input.maxOutputTokens } : {}),
    ...(input.sandboxPermissions ? { sandboxPermissions: input.sandboxPermissions } : {}),
  }
}

function createWriteInput(input: {
  chars?: string
  sessionId: string
  yieldTimeMs: number
}): CodexShellWriteInput {
  return {
    sessionId: input.sessionId,
    yieldTimeMs: input.yieldTimeMs,
    ...(input.chars !== undefined ? { chars: input.chars } : {}),
  }
}

function parseSandboxPermissions(value: string | undefined): CodexShellSandboxPermissions | undefined {
  if (!value) {
    return undefined
  }

  if (value === 'useDefault' || value === 'requireEscalated') {
    return value
  }

  throw new TypeError(`Unsupported --sandbox value "${value}".`)
}

function parseOptionalNumber(value: string | undefined, name: string): number | undefined {
  if (!value) {
    return undefined
  }

  const numeric = Number.parseInt(value, 10)
  if (Number.isNaN(numeric)) {
    throw new TypeError(`${name} must be an integer.`)
  }

  return numeric
}

function buildHelpText(): string {
  return [
    'codex-sandbox',
    '',
    'Commands:',
    '  exec   Run one shell command through the native host',
    '  smoke  Run a simple printf smoke command',
    '',
    'Common options:',
    '  --cmd <string>',
    '  --host-binary <path>',
    '  --config-path <path>',
    '  --cwd <path>',
    '  --shell <path>',
    '  --zsh-binary <path>',
    '  --execve-wrapper-binary <path>',
    '  --sandbox useDefault|requireEscalated',
    '  --yield-ms <int>',
    '  --timeout-ms <int>',
    '  --max-output-tokens <int>',
    '  --tty',
    '  --json',
  ].join('\n')
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
