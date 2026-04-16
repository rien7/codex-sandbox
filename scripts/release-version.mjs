import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const version = readVersionArg()
const tag = `v${version}`
const files = [
  resolve(rootDir, 'package.json'),
  resolve(rootDir, 'packages', 'codex-sandbox-adapter', 'package.json'),
  resolve(rootDir, 'packages', 'codex-sandbox-cli', 'package.json'),
]

ensureCleanWorktree()
ensureTagDoesNotExist(tag)

for (const filePath of files) {
  updatePackageVersion(filePath, version)
}

runGit(['add', ...files.map(filePath => relativeToRoot(filePath))])
runGit(['commit', '-m', `Release ${tag}`])
runGit(['tag', '-a', tag, '-m', tag])

process.stdout.write([
  `Prepared release ${tag}.`,
  '',
  'Created:',
  `- commit: Release ${tag}`,
  `- tag: ${tag}`,
  '',
  'Next:',
  '- git push origin main --follow-tags',
  '',
].join('\n'))

function readVersionArg() {
  const input = process.argv[2]?.trim()
  if (!input) {
    fail('Usage: pnpm run release:version -- <version>')
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(input)) {
    fail(`Invalid semver version: ${input}`)
  }
  return input
}

function updatePackageVersion(filePath, version) {
  const json = JSON.parse(readFileSync(filePath, 'utf8'))
  json.version = version
  writeFileSync(filePath, `${JSON.stringify(json, null, 2)}\n`)
}

function ensureCleanWorktree() {
  const output = execGit(['status', '--porcelain'])
  if (output.trim()) {
    fail('Working tree is not clean. Commit or stash changes before running release:version.')
  }
}

function ensureTagDoesNotExist(tag) {
  const output = execGit(['tag', '--list', tag])
  if (output.trim() === tag) {
    fail(`Git tag already exists: ${tag}`)
  }
}

function runGit(args) {
  execFileSync('git', args, {
    cwd: rootDir,
    stdio: 'inherit',
  })
}

function execGit(args) {
  return execFileSync('git', args, {
    cwd: rootDir,
    encoding: 'utf8',
  })
}

function relativeToRoot(filePath) {
  return filePath.slice(rootDir.length + 1)
}

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}
