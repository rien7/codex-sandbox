import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { CodexShellAdapter } from '../packages/codex-sandbox-adapter/src/index.js'

const fixturePath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'fake-codex-shell-host.mjs',
)

function createHostWrapper(): string {
  const wrapperDir = mkdtempSync(join(tmpdir(), 'codex-sandbox-host-'))
  const wrapperPath = join(wrapperDir, 'codex-sandbox-host')
  writeFileSync(wrapperPath, `#!/bin/sh\nexec "${process.execPath}" "${fixturePath}" "$@"\n`, 'utf8')
  chmodSync(wrapperPath, 0o755)
  return wrapperPath
}

describe('@rien7/codex-sandbox', () => {
  it('runs buffered commands through the standalone adapter', async () => {
    const adapter = new CodexShellAdapter({
      hostBinary: createHostWrapper(),
      codexHome: mkdtempSync(join(tmpdir(), 'codex-sandbox-home-')),
    })

    try {
      const result = await adapter.exec({ cmd: 'printf hello' })
      expect(result).toMatchObject({
        running: false,
        output: 'ran:printf hello',
        latestChunk: 'ran:printf hello',
      })
    }
    finally {
      await adapter.close()
    }
  })

  it('keeps interactive sessions open and appends later chunks', async () => {
    const adapter = new CodexShellAdapter({
      hostBinary: createHostWrapper(),
      codexHome: mkdtempSync(join(tmpdir(), 'codex-sandbox-home-')),
    })

    try {
      const started = await adapter.exec({
        cmd: 'cat',
        tty: true,
      })

      expect(started).toMatchObject({
        sessionId: '41',
        running: true,
        output: 'hello ',
      })

      const completed = await adapter.writeToSession({
        sessionId: '41',
        chars: 'done\n',
      })

      expect(completed).toMatchObject({
        running: false,
        exitCode: 0,
        output: 'hello echo:done\n',
        latestChunk: 'echo:done\n',
      })
    }
    finally {
      await adapter.close()
    }
  })
})
