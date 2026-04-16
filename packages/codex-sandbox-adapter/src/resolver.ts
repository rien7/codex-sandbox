import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

export type NativeShellAssetSource
  = | 'explicit'
    | 'env'
    | 'package-native'
    | 'repo-dist'
    | 'repo-build'
    | 'system'

export interface NativeShellBinaryResolution {
  binaryPath: string
  source: NativeShellAssetSource
}

export interface NativeShellBridgeResolution {
  zshBinary: NativeShellBinaryResolution
  execveWrapperBinary: NativeShellBinaryResolution
}

export interface NativeShellBundleResolution {
  hostBinary: NativeShellBinaryResolution
  bridge?: NativeShellBridgeResolution
}

export interface ResolveNativeShellBundleOptions {
  hostBinary?: string
  zshBinary?: string
  execveWrapperBinary?: string
  env?: NodeJS.ProcessEnv
  cwd?: string
}

/** Resolve packaged or prebuilt native assets for the standalone adapter. */
export function resolveNativeShellBundle(
  options: ResolveNativeShellBundleOptions = {},
): NativeShellBundleResolution | undefined {
  const env = options.env ?? process.env
  const cwd = options.cwd ?? process.cwd()
  const hostBinary = resolveNativeHostBinary({
    ...(options.hostBinary ? { explicitPath: options.hostBinary } : {}),
    env,
    cwd,
  })
  if (!hostBinary) {
    return undefined
  }

  const bridge = resolveNativeShellBridge({
    ...(options.zshBinary ? { explicitZshPath: options.zshBinary } : {}),
    ...(options.execveWrapperBinary ? { explicitExecveWrapperPath: options.execveWrapperBinary } : {}),
    env,
    cwd,
    hostBinaryPath: hostBinary.binaryPath,
  })

  return {
    hostBinary,
    ...(bridge ? { bridge } : {}),
  }
}

/** Resolve the main host binary. */
export function resolveNativeHostBinary(options: {
  explicitPath?: string
  env?: NodeJS.ProcessEnv
  cwd?: string
} = {}): NativeShellBinaryResolution | undefined {
  const env = options.env ?? process.env
  const cwd = options.cwd ?? process.cwd()
  const envPath = env.CODEX_SANDBOX_HOST_BINARY
    ?? env.CODEX_SHELL_HOST_BINARY
    ?? env.SHELL_CODEX_BINARY
  const systemCandidate = resolveSystemBinary(env, 'codex-sandbox-host')
    ?? resolveSystemBinary(env, 'sandbox-unified-exec-host')
  const candidates = resolveAssetCandidates({
    assetName: 'codex-sandbox-host',
    ...(options.explicitPath ? { explicitPath: options.explicitPath } : {}),
    ...(envPath ? { envPath } : {}),
    cwd,
    repoBuildCandidates: [
      resolve(cwd, 'native', 'sandbox-host', 'target', 'release', 'sandbox-unified-exec-host'),
    ],
    ...(systemCandidate ? { systemCandidate } : {}),
  })

  return candidates.find(candidate => candidate && existsSync(candidate.binaryPath))
}

/** Resolve patched zsh plus exec wrapper when both are available. */
export function resolveNativeShellBridge(options: {
  explicitZshPath?: string
  explicitExecveWrapperPath?: string
  hostBinaryPath?: string
  env?: NodeJS.ProcessEnv
  cwd?: string
} = {}): NativeShellBridgeResolution | undefined {
  const env = options.env ?? process.env
  const cwd = options.cwd ?? process.cwd()
  const siblingDir = options.hostBinaryPath ? dirname(options.hostBinaryPath) : undefined
  const zshEnvPath = env.CODEX_SANDBOX_ZSH_BINARY
    ?? env.CODEX_SHELL_ZSH_BINARY
    ?? env.SHELL_CODEX_ZSH_BINARY
  const zshBinary = resolveOptionalAsset(
    resolveAssetCandidates({
      assetName: 'zsh',
      ...(options.explicitZshPath ? { explicitPath: options.explicitZshPath } : {}),
      ...(zshEnvPath ? { envPath: zshEnvPath } : {}),
      cwd,
      repoBuildCandidates: siblingDir ? [resolve(siblingDir, 'zsh')] : [],
    }),
  )
  const execveEnvPath = env.CODEX_SANDBOX_EXECVE_WRAPPER_BINARY
    ?? env.CODEX_SHELL_EXECVE_WRAPPER_BINARY
    ?? env.SHELL_CODEX_EXECVE_WRAPPER_BINARY
  const execveWrapperBinary = resolveOptionalAsset(
    resolveAssetCandidates({
      assetName: 'codex-execve-wrapper',
      ...(options.explicitExecveWrapperPath ? { explicitPath: options.explicitExecveWrapperPath } : {}),
      ...(execveEnvPath ? { envPath: execveEnvPath } : {}),
      cwd,
      repoBuildCandidates: [
        ...(siblingDir ? [resolve(siblingDir, 'codex-execve-wrapper')] : []),
        resolve(cwd, 'native', 'vendor', 'codex-rs', 'target', 'release', 'codex-execve-wrapper'),
      ],
    }),
  )

  if (!zshBinary || !execveWrapperBinary) {
    return undefined
  }

  return { zshBinary, execveWrapperBinary }
}

/** Stable platform key shared by the build and runtime sides. */
export function getNativePlatformKey(): string {
  const arch = process.arch === 'x64'
    ? 'x64'
    : process.arch === 'arm64'
      ? 'arm64'
      : process.arch

  switch (process.platform) {
    case 'darwin':
      return `darwin-${arch}`
    case 'linux':
      return `linux-${arch}`
    default:
      return `${process.platform}-${arch}`
  }
}

function normalizeCandidatePath(value: string | undefined): string | undefined {
  const normalized = value?.trim()
  return normalized || undefined
}

function resolveOptionalAsset(
  candidates: Array<NativeShellBinaryResolution | undefined>,
): NativeShellBinaryResolution | undefined {
  return candidates.find(candidate => candidate && existsSync(candidate.binaryPath))
}

function resolveAssetCandidates(options: {
  assetName: string
  explicitPath?: string
  envPath?: string
  cwd: string
  repoBuildCandidates?: string[]
  systemCandidate?: NativeShellBinaryResolution
}): Array<NativeShellBinaryResolution | undefined> {
  const platformKey = getNativePlatformKey()
  const sourceDir = dirname(fileURLToPath(import.meta.url))
  const explicitPath = normalizeCandidatePath(options.explicitPath)
  const envPath = normalizeCandidatePath(options.envPath)
  const packageNativeBinaryPath = resolve(sourceDir, '../native', platformKey, options.assetName)
  const repoDistBinaryPath = resolve(options.cwd, 'dist', 'native', platformKey, options.assetName)
  const repoBuildCandidates = options.repoBuildCandidates ?? []

  return [
    explicitPath ? { binaryPath: explicitPath, source: 'explicit' } : undefined,
    envPath ? { binaryPath: envPath, source: 'env' } : undefined,
    { binaryPath: packageNativeBinaryPath, source: 'package-native' },
    { binaryPath: repoDistBinaryPath, source: 'repo-dist' },
    ...repoBuildCandidates.map(binaryPath => ({ binaryPath, source: 'repo-build' as const })),
    options.systemCandidate,
  ]
}

function resolveSystemBinary(
  env: NodeJS.ProcessEnv,
  binaryName: string,
): NativeShellBinaryResolution | undefined {
  const pathValue = env.PATH
  if (!pathValue) {
    return undefined
  }

  for (const segment of pathValue.split(':')) {
    if (!segment) {
      continue
    }

    const candidate = join(segment, binaryName)
    if (existsSync(candidate)) {
      return {
        binaryPath: candidate,
        source: 'system',
      }
    }
  }

  return undefined
}
