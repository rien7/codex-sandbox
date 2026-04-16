import type { HostExecCommandResult } from './protocol.js';
import type { CodexShellSandboxPermissions, CodexShellSessionSnapshot } from './types.js';
export interface CodexShellSessionRecord extends CodexShellSessionSnapshot {
    sessionId: string;
}
/** Keep interactive session output in one place for the adapter and CLI. */
export declare class CodexShellSessionStore {
    private readonly sessions;
    createRunningSession(input: {
        sessionId: string;
        command: string;
        cwd: string;
        sandboxPermissions: CodexShellSandboxPermissions;
        initialChunk: string;
    }): CodexShellSessionRecord;
    appendResult(sessionId: string, result: HostExecCommandResult): CodexShellSessionRecord | undefined;
    get(sessionId: string): CodexShellSessionRecord | undefined;
    values(): CodexShellSessionRecord[];
    delete(sessionId: string): void;
}
//# sourceMappingURL=session-store.d.ts.map