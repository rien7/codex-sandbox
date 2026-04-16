import { CodexShellAdapter } from '@rien7/codex-sandbox'

async function main(): Promise<void> {
  const adapter = new CodexShellAdapter()

  try {
    const result = await adapter.exec({
      cmd: 'printf codex-sandbox-example',
    })

    process.stdout.write(`${result.output}\n`)
  }
  finally {
    await adapter.close()
  }
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
})
