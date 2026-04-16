#!/usr/bin/env node
import process from 'node:process'

import { runCli } from './runner.js'

void runCli(process.argv.slice(2)).then((exitCode) => {
  process.exitCode = exitCode
}).catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
})
