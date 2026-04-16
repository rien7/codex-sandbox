# @codex-sandbox/cli

This package provides the `codex-sandbox` command.

It uses `@rien7/codex-sandbox` and shows approval choices inline when the host asks for permission.

## Example

```bash
codex-sandbox exec --cmd 'sudo whoami'
```

When the host requests approval, the CLI prints the available choices and waits for the user to choose one before execution continues. There is no separate approval mode flag in normal use.
