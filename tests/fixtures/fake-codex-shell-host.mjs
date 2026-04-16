#!/usr/bin/env node

import process from 'node:process'
import { createInterface } from 'node:readline'

const pendingApprovals = new Map()

const readline = createInterface({
  input: process.stdin,
  crlfDelay: Number.POSITIVE_INFINITY,
})

readline.on('line', (line) => {
  if (!line.trim()) {
    return
  }

  const message = JSON.parse(line)
  const { id, method, params } = message

  if (method === 'initialize') {
    writeResponse(id, {
      userAgent: 'fake-codex-shell-host',
      platformFamily: 'test',
      platformOs: 'test',
    })
    return
  }

  if (method === 'command/exec') {
    if (params.cmd.includes('sudo')) {
      const approvalId = `approval-${params.itemId}`
      pendingApprovals.set(approvalId, { id, params })
      writeNotification('item/commandExecution/requestApproval', {
        itemId: params.itemId,
        approvalId,
        command: params.cmd,
        cwd: params.cwd,
        availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'],
      })
      return
    }

    if (params.tty) {
      writeResponse(id, {
        itemId: params.itemId,
        sessionId: '41',
        output: 'hello ',
        chunkId: 'chunk-session-start',
        wallTimeMs: 5,
      })
      return
    }

    writeResponse(id, {
      itemId: params.itemId,
      exitCode: 0,
      output: `ran:${params.cmd}`,
      chunkId: 'chunk-buffered',
      wallTimeMs: 5,
    })
    return
  }

  if (method === 'command/writeStdin') {
    const chars = params.chars ?? ''
    writeResponse(id, {
      itemId: params.itemId,
      exitCode: chars.includes('done') ? 0 : undefined,
      output: chars ? `echo:${chars}` : '',
      chunkId: 'chunk-session-write',
      wallTimeMs: 5,
    })
    return
  }

  if (method === 'command/terminate') {
    writeResponse(id, null)
    return
  }

  if (method === 'approval/respond') {
    const pending = pendingApprovals.get(params.approvalId)
    if (!pending) {
      writeResponse(id, null)
      return
    }

    pendingApprovals.delete(params.approvalId)
    writeResponse(id, null)
    writeResponse(pending.id, {
      itemId: pending.params.itemId,
      exitCode: params.decision === 'decline' || params.decision === 'cancel' ? 1 : 0,
      output: `${params.decision}:${pending.params.cmd}`,
      chunkId: 'chunk-approved',
      wallTimeMs: 5,
    })
  }
})

function writeNotification(method, params) {
  process.stdout.write(`${JSON.stringify({ method, params })}\n`)
}

function writeResponse(id, result) {
  process.stdout.write(`${JSON.stringify({ id, result })}\n`)
}
