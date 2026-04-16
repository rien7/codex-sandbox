import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const MANAGED_CONFIG_MARKER = '# Managed by codex-sandbox-adapter. Do not edit by hand.';
/**
 * Keep a dedicated CODEX_HOME ready for the standalone adapter.
 * The config file is only rewritten when this package owns it.
 */
export async function prepareCodexHome(input) {
    await mkdir(input.codexHome, { recursive: true });
    const managedConfig = buildManagedCodexConfig(input);
    if (!managedConfig) {
        return;
    }
    const configPath = join(input.codexHome, 'config.toml');
    const existing = await readOptionalTextFile(configPath);
    if (existing && !existing.startsWith(MANAGED_CONFIG_MARKER)) {
        return;
    }
    if (existing === managedConfig) {
        return;
    }
    await writeFile(configPath, managedConfig, 'utf8');
}
function buildManagedCodexConfig(input) {
    if (!input.bridge) {
        return undefined;
    }
    return [
        MANAGED_CONFIG_MARKER,
        '',
        `zsh_path = "${escapeTomlString(input.bridge.zshBinary.binaryPath)}"`,
        `main_execve_wrapper_exe = "${escapeTomlString(input.bridge.execveWrapperBinary.binaryPath)}"`,
        '',
        '[features]',
        'shell_zsh_fork = true',
        '',
    ].join('\n');
}
async function readOptionalTextFile(filePath) {
    try {
        return await readFile(filePath, 'utf8');
    }
    catch (error) {
        if (isFileMissingError(error)) {
            return undefined;
        }
        throw error;
    }
}
function escapeTomlString(value) {
    return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}
function isFileMissingError(error) {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
//# sourceMappingURL=codex-home.js.map