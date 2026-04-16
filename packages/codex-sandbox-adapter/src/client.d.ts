import type { HostApprovalRequest, HostApprovalResponseParams, HostExecCommandParams, HostExecCommandResult, HostTerminateParams, HostWriteStdinParams } from './protocol.js';
import type { NativeShellBridgeResolution } from './resolver.js';
export interface CodexShellNativeClient {
    start: () => Promise<void>;
    shutdown: () => Promise<void>;
    exec: (params: HostExecCommandParams, signal?: AbortSignal) => Promise<HostExecCommandResult>;
    writeToSession: (params: HostWriteStdinParams, signal?: AbortSignal) => Promise<HostExecCommandResult>;
    terminateSession: (params: HostTerminateParams) => Promise<void>;
    respondToApproval: (params: HostApprovalResponseParams) => Promise<void>;
    onApprovalRequest: (listener: (event: HostApprovalRequest) => void) => () => void;
}
export interface CodexShellHostClientOptions {
    binaryPath: string;
    codexHome: string;
    bridge?: NativeShellBridgeResolution;
    launchArgs?: string[];
    cwd?: string;
    env?: NodeJS.ProcessEnv;
}
/** Own one native sandbox host process and route JSON-RPC requests over stdio. */
export declare class CodexShellHostClient implements CodexShellNativeClient {
    private readonly options;
    private readonly approvalEvents;
    private readonly pendingRequests;
    private child;
    private initializePromise;
    private nextRequestId;
    private stderrLines;
    constructor(options: CodexShellHostClientOptions);
    start(): Promise<void>;
    shutdown(): Promise<void>;
    exec(params: HostExecCommandParams, signal?: AbortSignal): Promise<HostExecCommandResult>;
    writeToSession(params: HostWriteStdinParams, signal?: AbortSignal): Promise<HostExecCommandResult>;
    terminateSession(params: HostTerminateParams): Promise<void>;
    respondToApproval(params: HostApprovalResponseParams): Promise<void>;
    onApprovalRequest(listener: (event: HostApprovalRequest) => void): () => void;
    private startInternal;
    private handleStdoutLine;
    private sendRequest;
}
//# sourceMappingURL=client.d.ts.map