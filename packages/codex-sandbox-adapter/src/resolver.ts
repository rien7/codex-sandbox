import { existsSync } from 'node:fs'
import { delimiter, dirname, join, resolve } from 'node:path'
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
  const searchRoots = collectSearchRoots(cwd)
  const envPath = env.CODEX_SANDBOX_HOST_BINARY
    ?? env.CODEX_SHELL_HOST_BINARY
    ?? env.SHELL_CODEX_BINARY
  const systemCandidate = resolveSystemBinary(env, executableNameForCurrentPlatform('codex-sandbox-host'))
    ?? resolveSystemBinary(env, executableNameForCurrentPlatform('sandbox-unified-exec-host'))
  const candidates = resolveAssetCandidates({
    assetName: executableNameForCurrentPlatform('codex-sandbox-host'),
    ...(options.explicitPath ? { explicitPath: options.explicitPath } : {}),
    ...(envPath ? { envPath } : {}),
    cwd,
    searchRoots,
    repoBuildCandidates: [
      ...searchRoots.map(root => (
        executablePathForCurrentPlatform(resolve(root, 'native', 'sandbox-host', 'target', 'release', 'sandbox-unified-exec-host'))
      )),
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
  const searchRoots = collectSearchRoots(cwd)
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
      searchRoots,
      repoBuildCandidates: siblingDir ? [resolve(siblingDir, 'zsh')] : [],
    }),
  )
  const execveEnvPath = env.CODEX_SANDBOX_EXECVE_WRAPPER_BINARY
    ?? env.CODEX_SHELL_EXECVE_WRAPPER_BINARY
    ?? env.SHELL_CODEX_EXECVE_WRAPPER_BINARY
  const execveWrapperBinary = resolveOptionalAsset(
    resolveAssetCandidates({
      assetName: executableNameForCurrentPlatform('codex-execve-wrapper'),
      ...(options.explicitExecveWrapperPath ? { explicitPath: options.explicitExecveWrapperPath } : {}),
      ...(execveEnvPath ? { envPath: execveEnvPath } : {}),
      cwd,
      searchRoots,
      repoBuildCandidates: [
        ...(siblingDir ? [executablePathForCurrentPlatform(resolve(siblingDir, 'codex-execve-wrapper'))] : []),
        ...searchRoots.map(root => (
          executablePathForCurrentPlatform(resolve(root, 'native', 'vendor', 'codex-rs', 'target', 'release', 'codex-execve-wrapper'))
        )),
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
  searchRoots?: string[]
  repoBuildCandidates?: string[]
  systemCandidate?: NativeShellBinaryResolution
}): Array<NativeShellBinaryResolution | undefined> {
  const platformKey = getNativePlatformKey()
  const sourceDir = dirname(fileURLToPath(import.meta.url))
  const searchRoots = options.searchRoots ?? [options.cwd]
  const explicitPath = normalizeCandidatePath(options.explicitPath)
  const envPath = normalizeCandidatePath(options.envPath)
  const packageNativeBinaryPath = resolve(sourceDir, '../native', platformKey, options.assetName)
  const repoDistCandidates = searchRoots.map(root => (
    resolve(root, 'dist', 'native', platformKey, options.assetName)
  ))
  const repoBuildCandidates = options.repoBuildCandidates ?? []
  const seen = new Set<string>()

  return dedupeCandidates([
    explicitPath ? { binaryPath: explicitPath, source: 'explicit' } : undefined,
    envPath ? { binaryPath: envPath, source: 'env' } : undefined,
    { binaryPath: packageNativeBinaryPath, source: 'package-native' },
    ...repoDistCandidates.map(binaryPath => ({ binaryPath, source: 'repo-dist' as const })),
    ...repoBuildCandidates.map(binaryPath => ({ binaryPath, source: 'repo-build' as const })),
    options.systemCandidate,
  ], seen)
}

function resolveSystemBinary(
  env: NodeJS.ProcessEnv,
  binaryName: string,
): NativeShellBinaryResolution | undefined {
  const pathValue = env.PATH
  if (!pathValue) {
    return undefined
  }

  for (const segment of pathValue.split(delimiter)) {
    if (!segment) {
      continue
    }

    for (const candidateName of getExecutableCandidateNames(binaryName)) {
      const candidate = join(segment, candidateName)
      if (existsSync(candidate)) {
        return {
          binaryPath: candidate,
          source: 'system',
        }
      }
    }
  }

  return undefined
}

function collectSearchRoots(cwd: string): string[] {
  const roots: string[] = []
  let current = resolve(cwd)
  while (true) {
    roots.push(current)
    const parent = dirname(current)
    if (parent === current) {
      break
    }
    current = parent
  }

  return roots
}

function dedupeCandidates(
  candidates: Array<NativeShellBinaryResolution | undefined>,
  seen: Set<string>,
): Array<NativeShellBinaryResolution | undefined> {
  return candidates.filter((candidate) => {
    if (!candidate) {
      return false
    }
    if (seen.has(candidate.binaryPath)) {
      return false
    }
    seen.add(candidate.binaryPath)
    return true
  })
}

function executableNameForCurrentPlatform(binaryName: string): string {
  return executableNameForPlatform(binaryName, process.platform)
}

function executableNameForPlatform(binaryName: string, platform: NodeJS.Platform): string {
  if (platform === 'win32' && !binaryName.endsWith('.exe')) {
    return `${binaryName}.exe`
  }

  return binaryName
}

function executablePathForCurrentPlatform(binaryPath: string): string {
  return process.platform === 'win32' && !binaryPath.endsWith('.exe')
    ? `${binaryPath}.exe`
    : binaryPath
}

function getExecutableCandidateNames(binaryName: string): string[] {
  if (process.platform === 'win32' && !binaryName.endsWith('.exe')) {
    return [`${binaryName}.exe`, binaryName]
  }

  return [binaryName]
}
