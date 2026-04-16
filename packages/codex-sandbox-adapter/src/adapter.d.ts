import type { CodexShellAdapterOptions, CodexShellExecInput, CodexShellResult, CodexShellSessionSnapshot, CodexShellWriteInput } from './types.js';
export interface CodexShellAdapterRuntime {
    start: () => Promise<void>;
    close: () => Promise<void>;
    exec: (input: CodexShellExecInput, signal?: AbortSignal) => Promise<CodexShellResult>;
    writeToSession: (input: CodexShellWriteInput, signal?: AbortSignal) => Promise<CodexShellResult>;
    terminateSession: (sessionId: string) => Promise<void>;
    getSessionSnapshot: (sessionId: string) => CodexShellSessionSnapshot | undefined;
    listSessions: () => CodexShellSessionSnapshot[];
}
/** High-level TypeScript adapter over the native Codex shell host protocol. */
export declare class CodexShellAdapter implements CodexShellAdapterRuntime {
    private readonly options;
    private readonly sessions;
    private readonly approvalContexts;
    private client;
    private clientPromise;
    private approvalUnsubscribe;
    constructor(options?: CodexShellAdapterOptions);
    start(): Promise<void>;
    close(): Promise<void>;
    exec(input: CodexShellExecInput, signal?: AbortSignal): Promise<CodexShellResult>;
    writeToSession(input: CodexShellWriteInput, signal?: AbortSignal): Promise<CodexShellResult>;
    terminateSession(sessionId: string): Promise<void>;
    getSessionSnapshot(sessionId: string): CodexShellSessionSnapshot | undefined;
    listSessions(): CodexShellSessionSnapshot[];
    private getClient;
    private createClient;
    private buildExecParams;
    private buildWriteParams;
    private consumeExecResult;
    private runWithApprovalContext;
    private handleApprovalRequest;
}
//# sourceMappingURL=adapter.d.ts.map