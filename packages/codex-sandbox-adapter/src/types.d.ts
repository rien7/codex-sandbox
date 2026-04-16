import type { HostApprovalDecision } from './protocol.js';
export type CodexShellSandboxPermissions = 'useDefault' | 'requireEscalated';
export type CodexShellApprovalDecision = HostApprovalDecision;
export interface CodexShellApprovalRequest {
    itemId: string;
    approvalId: string;
    command?: string;
    cwd?: string;
    reason?: string;
    availableDecisions?: CodexShellApprovalDecision[];
}
export interface CodexShellApprovalContext {
    itemId: string;
    sandboxPermissions: CodexShellSandboxPermissions;
}
export type CodexShellApprovalResolver = (request: CodexShellApprovalRequest, context: CodexShellApprovalContext | undefined) => Promise<CodexShellApprovalDecision> | CodexShellApprovalDecision;
export interface CodexShellExecInput {
    cmd: string;
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
    yieldTimeMs?: number;
    maxOutputTokens?: number;
    tty?: boolean;
    login?: boolean;
    shell?: string;
    sandboxPermissions?: CodexShellSandboxPermissions;
}
export interface CodexShellWriteInput {
    sessionId: string;
    chars?: string;
    yieldTimeMs?: number;
    maxOutputTokens?: number;
}
export interface CodexShellResult {
    sessionId?: string;
    command: string;
    cwd: string;
    exitCode?: number;
    running: boolean;
    output: string;
    latestChunk: string;
}
export interface CodexShellSessionSnapshot extends CodexShellResult {
    sandboxPermissions: CodexShellSandboxPermissions;
}
export interface CodexShellBridgeOptions {
    enabled?: boolean;
    zshBinary?: string;
    execveWrapperBinary?: string;
}
export interface CodexShellAdapterOptions {
    hostBinary?: string;
    codexHome?: string;
    shell?: string;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    launchArgs?: string[];
    approvalResolver?: CodexShellApprovalResolver;
    bridge?: CodexShellBridgeOptions;
}
//# sourceMappingURL=types.d.ts.map