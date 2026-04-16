import type { NativeShellBridgeResolution } from './resolver.js';
export interface PrepareCodexHomeInput {
    codexHome: string;
    bridge?: NativeShellBridgeResolution;
}
/**
 * Keep a dedicated CODEX_HOME ready for the standalone adapter.
 * The config file is only rewritten when this package owns it.
 */
export declare function prepareCodexHome(input: PrepareCodexHomeInput): Promise<void>;
//# sourceMappingURL=codex-home.d.ts.map