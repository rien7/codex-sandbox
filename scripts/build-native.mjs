import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const VENDOR_CODEX_RS_DIR = resolve(ROOT_DIR, 'native', 'vendor', 'codex-rs')

if (!existsSync(VENDOR_CODEX_RS_DIR)) {
  throw new Error('native/vendor/codex-rs is missing. This repo needs the curated Codex source subtree.')
}

const cargo = resolveSystemBinary('cargo')
if (!cargo) {
  throw new Error('Could not find cargo on PATH.')
}

buildBinary({
  cargo,
  manifestPath: resolve(VENDOR_CODEX_RS_DIR, 'Cargo.toml'),
  packageName: 'codex-core',
  binaryName: 'elara-unified-exec-host',
})

buildBinary({
  cargo,
  manifestPath: resolve(VENDOR_CODEX_RS_DIR, 'Cargo.toml'),
  packageName: 'codex-shell-escalation',
  binaryName: 'codex-execve-wrapper',
})

function buildBinary({ cargo, manifestPath, packageName, binaryName }) {
  execFileSync(cargo, [
    'build',
    '--manifest-path',
    manifestPath,
    '-p',
    packageName,
    '--bin',
    binaryName,
    '--release',
  ], {
    cwd: ROOT_DIR,
    stdio: 'inherit',
  })
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

