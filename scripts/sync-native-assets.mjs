import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUTPUT_DIR = resolve(ROOT_DIR, 'dist')
const platformKey = getNativePlatformKey()
const distNativeDir = join(OUTPUT_DIR, 'native', platformKey)
const packageNativeDir = resolve(ROOT_DIR, 'packages', 'codex-sandbox-adapter', 'native', platformKey)
const VENDOR_CODEX_RS_DIR = resolve(ROOT_DIR, 'native', 'vendor', 'codex-rs')

mkdirSync(distNativeDir, { recursive: true })
mkdirSync(packageNativeDir, { recursive: true })

const hostBinary = requireAsset(resolveHostBinary(), 'Codex sandbox host binary')
copyBinary(hostBinary, join(distNativeDir, 'codex-sandbox-host'))
copyBinary(hostBinary, join(packageNativeDir, 'codex-sandbox-host'))

const execveWrapperBinary = resolveExecveWrapperBinary(hostBinary)
if (execveWrapperBinary) {
  copyBinary(execveWrapperBinary, join(distNativeDir, 'codex-execve-wrapper'))
  copyBinary(execveWrapperBinary, join(packageNativeDir, 'codex-execve-wrapper'))
}
else {
  console.warn('Bridge asset missing: codex-execve-wrapper')
}

const zshBinary = resolveZshBinary(hostBinary)
if (zshBinary) {
  copyBinary(zshBinary, join(distNativeDir, 'zsh'))
  copyBinary(zshBinary, join(packageNativeDir, 'zsh'))
}
else {
  console.warn('Bridge asset missing: patched zsh')
}

function resolveHostBinary() {
  const envBinary = readEnvPath('CODEX_SANDBOX_HOST_BINARY')
  return (
    envBinary
    || resolveRepoBinary(['native', 'vendor', 'codex-rs', 'target', 'release', 'elara-unified-exec-host'])
    || resolveSystemBinary('codex-sandbox-host')
    || resolveSystemBinary('elara-unified-exec-host')
  )
}

function resolveExecveWrapperBinary(hostBinary) {
  const envBinary = readEnvPath('CODEX_SANDBOX_EXECVE_WRAPPER_BINARY')
  const siblingBinary = resolveSiblingBinary(hostBinary, 'codex-execve-wrapper')
  const repoBinary = resolveRepoBinary(['native', 'vendor', 'codex-rs', 'target', 'release', 'codex-execve-wrapper'])
  const tarball = readEnvPath('CODEX_SANDBOX_ZSH_TARBALL')

  return (
    envBinary
    || siblingBinary
    || repoBinary
    || (tarball ? extractBridgeAssetFromTarball(tarball, 'codex-execve-wrapper') : undefined)
  )
}

function resolveZshBinary(hostBinary) {
  const envBinary = readEnvPath('CODEX_SANDBOX_ZSH_BINARY')
  if (envBinary) {
    return envBinary
  }

  const siblingBinary = resolveSiblingBinary(hostBinary, 'zsh')
  if (siblingBinary) {
    return siblingBinary
  }

  const tarball = readEnvPath('CODEX_SANDBOX_ZSH_TARBALL')
  if (tarball) {
    return extractBridgeAssetFromTarball(tarball, 'zsh')
  }

  return undefined
}

function extractBridgeAssetFromTarball(tarballPath, assetName) {
  const tar = resolveSystemBinary('tar')
  if (!tar) {
    throw new Error(`Could not find tar on PATH while extracting ${assetName}.`)
  }

  const entryPath = resolveBridgeTarballEntry(assetName)
  const extractDir = resolve(ROOT_DIR, '.tmp', 'native-shell', platformKey)
  const targetBinary = resolve(extractDir, assetName)
  mkdirSync(extractDir, { recursive: true })

  const fileContents = execFileSync(tar, ['-xOf', tarballPath, entryPath], {
    stdio: ['ignore', 'pipe', 'inherit'],
    encoding: 'buffer',
    maxBuffer: 128 * 1024 * 1024,
  })
  writeFileSync(targetBinary, fileContents)
  tryChmod(targetBinary)
  return targetBinary
}

function resolveBridgeTarballEntry(assetName) {
  const entries = {
    zsh: {
      'darwin-arm64': 'package/vendor/aarch64-apple-darwin/zsh/macos-15/zsh',
      'linux-x64': 'package/vendor/x86_64-unknown-linux-musl/zsh/ubuntu-24.04/zsh',
      'linux-arm64': 'package/vendor/aarch64-unknown-linux-musl/zsh/ubuntu-24.04/zsh',
    },
    'codex-execve-wrapper': {
      'darwin-arm64': 'package/vendor/aarch64-apple-darwin/codex-execve-wrapper',
      'linux-x64': 'package/vendor/x86_64-unknown-linux-musl/codex-execve-wrapper',
      'linux-arm64': 'package/vendor/aarch64-unknown-linux-musl/codex-execve-wrapper',
    },
  }

  const entryPath = entries[assetName]?.[platformKey]
  if (!entryPath) {
    throw new Error(`No ${assetName} tarball mapping is defined for ${platformKey}.`)
  }

  return entryPath
}

function copyBinary(sourceBinary, targetBinary) {
  const resolvedSource = realpathSync(sourceBinary)
  copyFileSync(resolvedSource, targetBinary)
  tryChmod(targetBinary)
  console.log(`Bundled native asset: ${resolvedSource} -> ${targetBinary}`)
}

function tryChmod(filePath) {
  try {
    chmodSync(filePath, 0o755)
  }
  catch (error) {
    if (!isErrnoException(error) || error.code !== 'EPERM') {
      throw error
    }
  }
}

function requireAsset(path, label) {
  if (!path) {
    throw new Error(`Could not find ${label} to bundle.`)
  }

  return path
}

function resolveSiblingBinary(binaryPath, fileName) {
  if (!binaryPath) {
    return undefined
  }

  const candidate = resolve(binaryPath, '..', fileName)
  return existsSync(candidate) ? candidate : undefined
}

function resolveRepoBinary(segments) {
  const candidate = resolve(ROOT_DIR, ...segments)
  return existsSync(candidate) ? candidate : undefined
}

function resolveSystemBinary(binaryName) {
  const pathValue = process.env.PATH
  if (!pathValue) {
    return undefined
  }

  for (const segment of pathValue.split(':')) {
    if (!segment) {
      continue
    }

    const candidate = resolve(segment, binaryName)
    if (existsSync(candidate)) {
      return candidate
    }
  }

  return undefined
}

function readEnvPath(name) {
  const value = process.env[name]?.trim()
  return value || undefined
}

function getNativePlatformKey() {
  const arch = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : process.arch

  switch (process.platform) {
    case 'darwin':
      return `darwin-${arch}`
    case 'linux':
      return `linux-${arch}`
    default:
      return `${process.platform}-${arch}`
  }
}

function isErrnoException(error) {
  return error instanceof Error && 'code' in error
}
