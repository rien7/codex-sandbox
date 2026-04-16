# Other language integration

You do not need the Node adapter to use `codex-sandbox`.

## Transport

The host uses newline-delimited JSON-RPC over stdio.

Spawn the host binary, write one JSON object per line to stdin, and read one JSON object per line from stdout.

## Core methods

- `initialize`
- `command/exec`
- `command/writeStdin`
- `command/terminate`
- `approval/respond`

## Approval notification

The host sends this notification when a command needs approval:

```json
{
  "method": "item/commandExecution/requestApproval",
  "params": {
    "itemId": "item-123",
    "approvalId": "approval-123",
    "command": "sudo whoami",
    "cwd": "/work",
    "availableDecisions": ["accept", "acceptForSession", "decline", "cancel"]
  }
}
```

Your client should present the choices to the user and answer with:

```json
{
  "id": 7,
  "method": "approval/respond",
  "params": {
    "approvalId": "approval-123",
    "decision": "acceptForSession"
  }
}
```

## Suggested flow

1. start the host process
2. call `initialize`
3. send `command/exec`
4. if you receive `item/commandExecution/requestApproval`, ask the user inline
5. send `approval/respond`
6. continue reading command output until the response carries an `exitCode`

