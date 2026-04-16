fn main() -> anyhow::Result<()> {
    let runtime = tokio::runtime::Runtime::new()?;
    runtime.block_on(codex_core::elara_shell_host::run_stdio_server())
}
