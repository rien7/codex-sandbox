import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
/** Resolve packaged or prebuilt native assets for the standalone adapter. */
export function resolveNativeShellBundle(options = {}) {
    const env = options.env ?? process.env;
    const cwd = options.cwd ?? process.cwd();
    const hostBinary = resolveNativeHostBinary({
        ...(options.hostBinary ? { explicitPath: options.hostBinary } : {}),
        env,
        cwd,
    });
    if (!hostBinary) {
        return undefined;
    }
    const bridge = resolveNativeShellBridge({
        ...(options.zshBinary ? { explicitZshPath: options.zshBinary } : {}),
        ...(options.execveWrapperBinary ? { explicitExecveWrapperPath: options.execveWrapperBinary } : {}),
        env,
        cwd,
        hostBinaryPath: hostBinary.binaryPath,
    });
    return {
        hostBinary,
        ...(bridge ? { bridge } : {}),
    };
}
/** Resolve the main host binary. */
export function resolveNativeHostBinary(options = {}) {
    const env = options.env ?? process.env;
    const cwd = options.cwd ?? process.cwd();
    const envPath = env.CODEX_SANDBOX_HOST_BINARY
        ?? env.CODEX_SHELL_HOST_BINARY
        ?? env.ELARA_CODEX_BINARY
        ?? env.SHELL_CODEX_BINARY;
    const systemCandidate = resolveSystemBinary(env, 'codex-sandbox-host')
        ?? resolveSystemBinary(env, 'elara-unified-exec-host');
    const candidates = resolveAssetCandidates({
        assetName: 'codex-sandbox-host',
        ...(options.explicitPath ? { explicitPath: options.explicitPath } : {}),
        ...(envPath ? { envPath } : {}),
        cwd,
        repoBuildCandidates: [
            resolve(cwd, 'native', 'vendor', 'codex-rs', 'target', 'release', 'elara-unified-exec-host'),
        ],
        ...(systemCandidate ? { systemCandidate } : {}),
    });
    return candidates.find(candidate => candidate && existsSync(candidate.binaryPath));
}
/** Resolve patched zsh plus exec wrapper when both are available. */
export function resolveNativeShellBridge(options = {}) {
    const env = options.env ?? process.env;
    const cwd = options.cwd ?? process.cwd();
    const siblingDir = options.hostBinaryPath ? dirname(options.hostBinaryPath) : undefined;
    const zshEnvPath = env.CODEX_SANDBOX_ZSH_BINARY
        ?? env.CODEX_SHELL_ZSH_BINARY
        ?? env.ELARA_CODEX_ZSH_BINARY
        ?? env.SHELL_CODEX_ZSH_BINARY;
    const zshBinary = resolveOptionalAsset(resolveAssetCandidates({
        assetName: 'zsh',
        ...(options.explicitZshPath ? { explicitPath: options.explicitZshPath } : {}),
        ...(zshEnvPath ? { envPath: zshEnvPath } : {}),
        cwd,
        repoBuildCandidates: siblingDir ? [resolve(siblingDir, 'zsh')] : [],
    }));
    const execveEnvPath = env.CODEX_SANDBOX_EXECVE_WRAPPER_BINARY
        ?? env.CODEX_SHELL_EXECVE_WRAPPER_BINARY
        ?? env.ELARA_CODEX_EXECVE_WRAPPER_BINARY
        ?? env.SHELL_CODEX_EXECVE_WRAPPER_BINARY;
    const execveWrapperBinary = resolveOptionalAsset(resolveAssetCandidates({
        assetName: 'codex-execve-wrapper',
        ...(options.explicitExecveWrapperPath ? { explicitPath: options.explicitExecveWrapperPath } : {}),
        ...(execveEnvPath ? { envPath: execveEnvPath } : {}),
        cwd,
        repoBuildCandidates: [
            ...(siblingDir ? [resolve(siblingDir, 'codex-execve-wrapper')] : []),
            resolve(cwd, 'native', 'vendor', 'codex-rs', 'target', 'release', 'codex-execve-wrapper'),
        ],
    }));
    if (!zshBinary || !execveWrapperBinary) {
        return undefined;
    }
    return { zshBinary, execveWrapperBinary };
}
/** Stable platform key shared by the build and runtime sides. */
export function getNativePlatformKey() {
    const arch = process.arch === 'x64'
        ? 'x64'
        : process.arch === 'arm64'
            ? 'arm64'
            : process.arch;
    switch (process.platform) {
        case 'darwin':
            return `darwin-${arch}`;
        case 'linux':
            return `linux-${arch}`;
        default:
            return `${process.platform}-${arch}`;
    }
}
function normalizeCandidatePath(value) {
    const normalized = value?.trim();
    return normalized || undefined;
}
function resolveOptionalAsset(candidates) {
    return candidates.find(candidate => candidate && existsSync(candidate.binaryPath));
}
function resolveAssetCandidates(options) {
    const platformKey = getNativePlatformKey();
    const sourceDir = dirname(fileURLToPath(import.meta.url));
    const explicitPath = normalizeCandidatePath(options.explicitPath);
    const envPath = normalizeCandidatePath(options.envPath);
    const packageNativeBinaryPath = resolve(sourceDir, '../native', platformKey, options.assetName);
    const repoDistBinaryPath = resolve(options.cwd, 'dist', 'native', platformKey, options.assetName);
    const repoBuildCandidates = options.repoBuildCandidates ?? [];
    return [
        explicitPath ? { binaryPath: explicitPath, source: 'explicit' } : undefined,
        envPath ? { binaryPath: envPath, source: 'env' } : undefined,
        { binaryPath: packageNativeBinaryPath, source: 'package-native' },
        { binaryPath: repoDistBinaryPath, source: 'repo-dist' },
        ...repoBuildCandidates.map(binaryPath => ({ binaryPath, source: 'repo-build' })),
        options.systemCandidate,
    ];
}
function resolveSystemBinary(env, binaryName) {
    const pathValue = env.PATH;
    if (!pathValue) {
        return undefined;
    }
    for (const segment of pathValue.split(':')) {
        if (!segment) {
            continue;
        }
        const candidate = join(segment, binaryName);
        if (existsSync(candidate)) {
            return {
                binaryPath: candidate,
                source: 'system',
            };
        }
    }
    return undefined;
}
//# sourceMappingURL=resolver.js.map