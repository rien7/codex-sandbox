import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const sourceRoot = readFlag('--source-root') ?? resolve(ROOT_DIR, 'ci', 'native-artifacts')
const targetRoot = readFlag('--target-root') ?? resolve(ROOT_DIR, 'packages', 'codex-sandbox-adapter', 'native')

rmSync(targetRoot, { recursive: true, force: true })
mkdirSync(targetRoot, { recursive: true })

for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) {
    continue
  }

  const platformKey = entry.name.startsWith('adapter-native-')
    ? entry.name.slice('adapter-native-'.length)
    : entry.name
  const sourceDir = resolve(sourceRoot, entry.name)
  const targetDir = resolve(targetRoot, platformKey)
  mkdirSync(targetDir, { recursive: true })

  for (const assetName of ['codex-sandbox-host', 'codex-execve-wrapper', 'zsh']) {
    const sourceAsset = resolve(sourceDir, assetName)
    if (existsSync(sourceAsset)) {
      cpSync(sourceAsset, resolve(targetDir, assetName))
    }
  }
}

function readFlag(name) {
  const index = process.argv.indexOf(name)
  if (index >= 0 && process.argv[index + 1]) {
    return process.argv[index + 1]
  }

  return undefined
}

