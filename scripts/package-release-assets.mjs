import { chmodSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, delimiter, dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIST_DIR = resolve(ROOT_DIR, 'dist')
const RELEASE_DIR = resolve(DIST_DIR, 'release')
const platformKey = readPlatformKey()
const nativeDir = resolve(DIST_DIR, 'native', platformKey)
const hostAssetName = getExecutableAssetName('codex-sandbox-host')

if (!existsSync(resolve(nativeDir, hostAssetName))) {
  throw new Error(`Missing native asset ${hostAssetName} for ${platformKey}. Run build:native and sync:native first.`)
}

mkdirSync(RELEASE_DIR, { recursive: true })

const nativeStageDir = resolve(RELEASE_DIR, `codex-sandbox-native-${platformKey}`)
const cliStageDir = resolve(RELEASE_DIR, `codex-sandbox-cli-${platformKey}`)
rmSync(nativeStageDir, { recursive: true, force: true })
rmSync(cliStageDir, { recursive: true, force: true })

mkdirSync(nativeStageDir, { recursive: true })
mkdirSync(cliStageDir, { recursive: true })

cpSync(nativeDir, resolve(nativeStageDir, 'native'), { recursive: true })
cpSync(resolve(ROOT_DIR, 'LICENSE'), resolve(nativeStageDir, 'LICENSE'))
cpSync(resolve(ROOT_DIR, 'NOTICE'), resolve(nativeStageDir, 'NOTICE'))

const adapterPackageDir = resolve(ROOT_DIR, 'packages', 'codex-sandbox-adapter')
const cliPackageDir = resolve(ROOT_DIR, 'packages', 'codex-sandbox-cli')

copyPackage(adapterPackageDir, resolve(cliStageDir, 'node_modules', '@rien7', 'codex-sandbox'))
copyPackage(cliPackageDir, resolve(cliStageDir, 'node_modules', '@codex-sandbox', 'cli'))
cpSync(resolve(ROOT_DIR, 'LICENSE'), resolve(cliStageDir, 'LICENSE'))
cpSync(resolve(ROOT_DIR, 'NOTICE'), resolve(cliStageDir, 'NOTICE'))
writeFileSync(resolve(cliStageDir, 'README.txt'), [
  'codex-sandbox CLI distribution',
  '',
  'Run:',
  ...(platformKey.startsWith('win32-')
    ? ['  codex-sandbox.cmd exec --cmd "echo hello"']
    : ['  ./codex-sandbox exec --cmd "printf hello"']),
  '',
  'This launcher expects Node.js on PATH.',
  '',
].join('\n'))
writeLauncher(cliStageDir)

createTarball(nativeStageDir)
createTarball(cliStageDir)

function readPlatformKey() {
  const index = process.argv.indexOf('--platform-key')
  if (index >= 0 && process.argv[index + 1]) {
    return process.argv[index + 1]
  }

  return getNativePlatformKey()
}

function writeLauncher(stageDir) {
  if (platformKey.startsWith('win32-')) {
    writeFileSync(resolve(stageDir, 'codex-sandbox.cmd'), [
      '@echo off',
      'set DIR=%~dp0',
      'node "%DIR%node_modules\\@codex-sandbox\\cli\\dist\\index.js" %*',
      '',
    ].join('\r\n'))
    return
  }

  const filePath = resolve(stageDir, 'codex-sandbox')
  writeFileSync(filePath, [
    '#!/bin/sh',
    'DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"',
    'exec node "$DIR/node_modules/@codex-sandbox/cli/dist/index.js" "$@"',
    '',
  ].join('\n'))
  chmodSync(filePath, 0o755)
}

function copyPackage(sourceDir, targetDir) {
  mkdirSync(targetDir, { recursive: true })
  cpSync(resolve(sourceDir, 'package.json'), resolve(targetDir, 'package.json'))
  if (existsSync(resolve(sourceDir, 'README.md'))) {
    cpSync(resolve(sourceDir, 'README.md'), resolve(targetDir, 'README.md'))
  }
  if (existsSync(resolve(sourceDir, 'dist'))) {
    cpSync(resolve(sourceDir, 'dist'), resolve(targetDir, 'dist'), { recursive: true })
  }
  if (existsSync(resolve(sourceDir, 'native'))) {
    cpSync(resolve(sourceDir, 'native'), resolve(targetDir, 'native'), { recursive: true })
  }
}

function createTarball(stageDir) {
  const tar = resolveSystemBinary('tar')
  if (!tar) {
    throw new Error('Could not find tar on PATH.')
  }

  const archivePath = `${stageDir}.tar.gz`
  execFileSync(tar, [
    '-czf',
    archivePath,
    '-C',
    dirname(stageDir),
    basename(stageDir),
  ], {
    stdio: 'inherit',
  })
}

function resolveSystemBinary(binaryName) {
  const pathValue = process.env.PATH
  if (!pathValue) {
    return undefined
  }

  for (const segment of pathValue.split(delimiter)) {
    if (!segment) {
      continue
    }

    for (const candidateName of getExecutableCandidateNames(binaryName)) {
      const candidate = resolve(segment, candidateName)
      if (existsSync(candidate)) {
        return candidate
      }
    }
  }

  return undefined
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

function getExecutableAssetName(binaryName) {
  return platformKey.startsWith('win32-') && !binaryName.endsWith('.exe')
    ? `${binaryName}.exe`
    : binaryName
}

function getExecutableCandidateNames(binaryName) {
  if (process.platform === 'win32' && !binaryName.endsWith('.exe')) {
    return [`${binaryName}.exe`, binaryName]
  }

  return [binaryName]
}
