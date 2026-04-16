import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { NativeShellBridgeResolution } from './resolver.js'

const MANAGED_CONFIG_MARKER = '# Managed by codex-sandbox-adapter. Do not edit by hand.'

export interface PrepareCodexHomeInput {
  codexHome: string
  bridge?: NativeShellBridgeResolution
}

/**
 * Keep a dedicated `CODEX_HOME` ready for the standalone adapter.
 *
 * When bridge assets are available, this function writes a managed
 * `config.toml` that points Codex shell integration at the packaged `zsh`
 * and `codex-execve-wrapper` binaries. Existing non-managed configs are left
 * untouched.
 */
export async function prepareCodexHome(input: PrepareCodexHomeInput): Promise<void> {
  await mkdir(input.codexHome, { recursive: true })

  const managedConfig = buildManagedCodexConfig(input)
  if (!managedConfig) {
    return
  }

  const configPath = join(input.codexHome, 'config.toml')
  const existing = await readOptionalTextFile(configPath)
  if (existing && !existing.startsWith(MANAGED_CONFIG_MARKER)) {
    return
  }
  if (existing === managedConfig) {
    return
  }

  await writeFile(configPath, managedConfig, 'utf8')
}

function buildManagedCodexConfig(input: PrepareCodexHomeInput): string | undefined {
  if (!input.bridge) {
    return undefined
  }

  return [
    MANAGED_CONFIG_MARKER,
    '',
    `zsh_path = "${escapeTomlString(input.bridge.zshBinary.binaryPath)}"`,
    `main_execve_wrapper_exe = "${escapeTomlString(input.bridge.execveWrapperBinary.binaryPath)}"`,
    '',
    '[features]',
    'shell_zsh_fork = true',
    '',
  ].join('\n')
}

async function readOptionalTextFile(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, 'utf8')
  }
  catch (error) {
    if (isFileMissingError(error)) {
      return undefined
    }

    throw error
  }
}

function escapeTomlString(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}

function isFileMissingError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
