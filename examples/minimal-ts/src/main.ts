import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import {
  CodexShellAdapter,
  getDefaultConfigPath,
  getNativePlatformKey,
  resolveNativeShellBundle,
} from '@rien7/codex-sandbox'

const runtimeDir = dirname(fileURLToPath(import.meta.url))
const exampleRoot = resolve(runtimeDir, '..')
const repoRoot = resolve(exampleRoot, '..', '..')
const platformKey = getNativePlatformKey()
const workdir = resolve(exampleRoot, 'workspace')
const defaultConfigPath = getDefaultConfigPath()
const hostAssetName = executableNameForPlatformKey('codex-sandbox-host')
const hostBuildName = executableNameForPlatformKey('sandbox-unified-exec-host')
const wrapperBuildName = executableNameForPlatformKey('codex-execve-wrapper')

async function main(): Promise<void> {
  mkdirSync(workdir, { recursive: true })

  const bundle = resolveNativeShellBundle({
    cwd: workdir,
    env: process.env,
  })

  if (!bundle) {
    throw new Error([
      'Could not resolve native assets for the example.',
      `Expected one of these to exist for ${platformKey}:`,
      `- ${resolve(repoRoot, 'packages', 'codex-sandbox-adapter', 'native', platformKey, hostAssetName)}`,
      `- ${resolve(repoRoot, 'dist', 'native', platformKey, hostAssetName)}`,
      `- ${resolve(repoRoot, 'native', 'sandbox-host', 'target', 'release', hostBuildName)}`,
      'Or set CODEX_SANDBOX_HOST_BINARY explicitly.',
    ].join('\n'))
  }

  console.log('resolved paths', {
    repoRoot,
    exampleRoot,
    platformKey,
    workdir,
    defaultConfigPath,
    hostBinary: bundle.hostBinary,
    adapterNativeDir: resolve(repoRoot, 'packages', 'codex-sandbox-adapter', 'native', platformKey),
    repoDistNativeDir: resolve(repoRoot, 'dist', 'native', platformKey),
    repoHostBuildPath: resolve(repoRoot, 'native', 'sandbox-host', 'target', 'release', hostBuildName),
    repoWrapperBuildPath: resolve(repoRoot, 'native', 'vendor', 'codex-rs', 'target', 'release', wrapperBuildName),
    envOverrides: {
      host: 'CODEX_SANDBOX_HOST_BINARY=/absolute/path/to/codex-sandbox-host',
      zsh: 'CODEX_SANDBOX_ZSH_BINARY=/absolute/path/to/zsh',
      execveWrapper: 'CODEX_SANDBOX_EXECVE_WRAPPER_BINARY=/absolute/path/to/codex-execve-wrapper',
    },
    bridge: bundle.bridge ?? 'not resolved',
  })

  const adapter = new CodexShellAdapter({
    cwd: workdir,
    approvalResolver: async (request, context) => {
      console.log('approval request', {
        itemId: request.itemId,
        approvalId: request.approvalId,
        command: request.command,
        cwd: request.cwd,
        reason: request.reason,
        availableDecisions: request.availableDecisions,
        sandboxPermissions: context?.sandboxPermissions,
      })

      if ((request.command ?? '').includes('decline-me')) {
        console.log('approval decision', 'decline')
        return 'decline'
      }

      if ((request.command ?? '').includes('single-approval')) {
        console.log('approval decision', 'accept')
        return 'accept'
      }

      if (context?.sandboxPermissions === 'requireEscalated') {
        console.log('approval decision', 'acceptForSession')
        return 'acceptForSession'
      }

      console.log('approval decision', 'accept')
      return 'accept'
    },
  })

  try {
    const normalResult = await adapter.exec({
      cmd: 'printf "normal-case\\n"; pwd',
      cwd: workdir,
      maxOutputTokens: 256,
    })
    console.log('case 1: normal command', normalResult)

    const acceptOnceResult = await adapter.exec({
      cmd: 'printf "single-approval\\n"; pwd',
      cwd: workdir,
      sandboxPermissions: 'requireEscalated',
      maxOutputTokens: 256,
    })
    console.log('case 2: accept once', acceptOnceResult)

    const declinedResult = await adapter.exec({
      cmd: 'printf "decline-me\\n"',
      cwd: workdir,
      sandboxPermissions: 'requireEscalated',
      maxOutputTokens: 256,
    })
    console.log('case 3: decline', declinedResult)

    console.log([
      'case 4: accept for session',
      'The next escalated command returns `acceptForSession`.',
      'The interactive TTY session after it should reuse that approval in the current adapter process.',
    ].join('\n'))

    const acceptForSessionResult = await adapter.exec({
      cmd: 'printf "session-approval\\n"; pwd',
      cwd: workdir,
      sandboxPermissions: 'requireEscalated',
      maxOutputTokens: 256,
    })
    console.log('case 4 result: acceptForSession', acceptForSessionResult)

    const interactiveStart = await adapter.exec({
      cmd: [
        'printf "interactive-ready\\n"',
        'read -r line',
        'printf "interactive-echo:%s\\n" "$line"',
      ].join('; '),
      cwd: workdir,
      tty: true,
      sandboxPermissions: 'requireEscalated',
      yieldTimeMs: 250,
      maxOutputTokens: 256,
    })
    console.log('case 5: interactive session start', interactiveStart)

    if (!interactiveStart.sessionId || !interactiveStart.running) {
      throw new Error('Expected the interactive example to create a running session.')
    }

    console.log(
      'session snapshot after start',
      adapter.getSessionSnapshot(interactiveStart.sessionId),
    )

    const interactiveFinish = await adapter.writeToSession({
      sessionId: interactiveStart.sessionId,
      chars: 'hello-from-session\n',
      yieldTimeMs: 250,
      maxOutputTokens: 256,
    })
    console.log('case 5: interactive session finish', interactiveFinish)

    console.log('remaining sessions', adapter.listSessions())
  }
  finally {
    await adapter.close()
  }
}

void main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error)
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
})

function executableNameForPlatformKey(binaryName: string): string {
  return platformKey.startsWith('win32-') && !binaryName.endsWith('.exe')
    ? `${binaryName}.exe`
    : binaryName
}
