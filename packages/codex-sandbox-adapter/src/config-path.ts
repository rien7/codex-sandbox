import envPaths from 'env-paths'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

import type { NativeShellBridgeResolution } from './resolver.js'

const MANAGED_CONFIG_MARKER = '# Managed by codex-sandbox-adapter. Do not edit by hand.'

export interface PrepareConfigPathInput {
  configPath: string
  bridge?: NativeShellBridgeResolution
}

/** Resolve the adapter's default host configuration directory. */
export function getDefaultConfigPath(): string {
  if (process.platform === 'win32') {
    return envPaths('codex-sandbox', { suffix: '' }).config
  }

  return join(homedir(), '.config', 'codex-sandbox')
}

/**
 * Keep a dedicated config path ready for the standalone adapter.
 *
 * When bridge assets are available, this function writes a managed
 * `config.toml` that points Codex shell integration at the packaged `zsh`
 * and `codex-execve-wrapper` binaries. Existing non-managed configs are left
 * untouched.
 */
export async function prepareConfigPath(input: PrepareConfigPathInput): Promise<void> {
  await mkdir(input.configPath, { recursive: true })

  const managedConfig = buildManagedCodexConfig(input)
  if (!managedConfig) {
    return
  }

  const configPath = join(input.configPath, 'config.toml')
  const existing = await readOptionalTextFile(configPath)
  if (existing && !existing.startsWith(MANAGED_CONFIG_MARKER)) {
    return
  }
  if (existing === managedConfig) {
    return
  }

  await writeFile(configPath, managedConfig, 'utf8')
}

function buildManagedCodexConfig(input: PrepareConfigPathInput): string | undefined {
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
