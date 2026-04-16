import type { HostExecCommandResult } from './protocol.js'
import type { CodexShellSandboxPermissions, CodexShellSessionSnapshot } from './types.js'

const maxCaptureChars = 120_000

export interface CodexShellSessionRecord extends CodexShellSessionSnapshot {
  sessionId: string
}

/** Keep interactive session output in one place for the adapter and CLI. */
export class CodexShellSessionStore {
  private readonly sessions = new Map<string, CodexShellSessionRecord>()

  createRunningSession(input: {
    sessionId: string
    command: string
    cwd: string
    sandboxPermissions: CodexShellSandboxPermissions
    initialChunk: string
  }): CodexShellSessionRecord {
    const output = appendCappedText('', input.initialChunk)
    const record: CodexShellSessionRecord = {
      sessionId: input.sessionId,
      command: input.command,
      cwd: input.cwd,
      sandboxPermissions: input.sandboxPermissions,
      running: true,
      output,
      latestChunk: input.initialChunk,
    }

    this.sessions.set(input.sessionId, record)
    return record
  }

  appendResult(sessionId: string, result: HostExecCommandResult): CodexShellSessionRecord | undefined {
    const session = this.sessions.get(sessionId)
    if (!session) {
      return undefined
    }

    session.latestChunk = result.output
    if (result.output) {
      session.output = appendCappedText(session.output, result.output)
    }

    if (result.exitCode !== undefined) {
      session.running = false
      session.exitCode = result.exitCode
    }

    return session
  }

  get(sessionId: string): CodexShellSessionRecord | undefined {
    return this.sessions.get(sessionId)
  }

  values(): CodexShellSessionRecord[] {
    return [...this.sessions.values()]
  }

  delete(sessionId: string): void {
    this.sessions.delete(sessionId)
  }
}

function appendCappedText(current: string, chunk: string): string {
  const next = current + chunk
  if (next.length <= maxCaptureChars) {
    return next
  }

  return next.slice(next.length - maxCaptureChars)
}
