import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { runCli } from '../packages/codex-sandbox-cli/src/runner.js'

const fixturePath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'fake-codex-shell-host.mjs',
)

function createHostWrapper(): string {
  const wrapperDir = mkdtempSync(join(tmpdir(), 'codex-sandbox-cli-'))
  if (process.platform === 'win32') {
    const wrapperPath = join(wrapperDir, 'codex-sandbox-host.cmd')
    writeFileSync(
      wrapperPath,
      `@echo off\r\n"${process.execPath}" "${fixturePath}" %*\r\n`,
      'utf8',
    )
    return wrapperPath
  }

  const wrapperPath = join(wrapperDir, 'codex-sandbox-host')
  writeFileSync(wrapperPath, `#!/bin/sh\nexec "${process.execPath}" "${fixturePath}" "$@"\n`, 'utf8')
  chmodSync(wrapperPath, 0o755)
  return wrapperPath
}

function createOutputCollector(): { stream: Writable, read: () => string } {
  let output = ''
  return {
    stream: new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString()
        callback()
      },
    }),
    read: () => output,
  }
}

describe('@codex-sandbox/cli', () => {
  it('uses the inline approval callback before completing execution', async () => {
    const stdout = createOutputCollector()
    const stderr = createOutputCollector()
    const stdin = new PassThrough()

    const exitCode = await runCli([
      'exec',
      '--cmd',
      'sudo whoami',
      '--host-binary',
      createHostWrapper(),
    ], {
      stdin: stdin as NodeJS.ReadStream,
      stdout: stdout.stream as NodeJS.WriteStream,
      stderr: stderr.stream as NodeJS.WriteStream,
      prompt: async () => 'acceptForSession',
    })

    expect(exitCode).toBe(0)
    expect(stdout.read()).toContain('acceptForSession:sudo whoami')
  })
})
