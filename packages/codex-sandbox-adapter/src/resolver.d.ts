export type NativeShellAssetSource = 'explicit' | 'env' | 'package-native' | 'repo-dist' | 'repo-build' | 'system';
export interface NativeShellBinaryResolution {
    binaryPath: string;
    source: NativeShellAssetSource;
}
export interface NativeShellBridgeResolution {
    zshBinary: NativeShellBinaryResolution;
    execveWrapperBinary: NativeShellBinaryResolution;
}
export interface NativeShellBundleResolution {
    hostBinary: NativeShellBinaryResolution;
    bridge?: NativeShellBridgeResolution;
}
export interface ResolveNativeShellBundleOptions {
    hostBinary?: string;
    zshBinary?: string;
    execveWrapperBinary?: string;
    env?: NodeJS.ProcessEnv;
    cwd?: string;
}
/** Resolve packaged or prebuilt native assets for the standalone adapter. */
export declare function resolveNativeShellBundle(options?: ResolveNativeShellBundleOptions): NativeShellBundleResolution | undefined;
/** Resolve the main host binary. */
export declare function resolveNativeHostBinary(options?: {
    explicitPath?: string;
    env?: NodeJS.ProcessEnv;
    cwd?: string;
}): NativeShellBinaryResolution | undefined;
/** Resolve patched zsh plus exec wrapper when both are available. */
export declare function resolveNativeShellBridge(options?: {
    explicitZshPath?: string;
    explicitExecveWrapperPath?: string;
    hostBinaryPath?: string;
    env?: NodeJS.ProcessEnv;
    cwd?: string;
}): NativeShellBridgeResolution | undefined;
/** Stable platform key shared by the build and runtime sides. */
export declare function getNativePlatformKey(): string;
//# sourceMappingURL=resolver.d.ts.map