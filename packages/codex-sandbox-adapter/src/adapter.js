import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { CodexShellHostClient } from './client.js';
import { resolveNativeShellBundle } from './resolver.js';
import { CodexShellSessionStore } from './session-store.js';
const defaultYieldTimeMs = 1_000;
/** High-level TypeScript adapter over the native Codex shell host protocol. */
export class CodexShellAdapter {
    options;
    sessions = new CodexShellSessionStore();
    approvalContexts = new Map();
    client;
    clientPromise;
    approvalUnsubscribe;
    constructor(options = {}) {
        this.options = options;
    }
    async start() {
        await this.getClient();
    }
    async close() {
        const client = this.client;
        const approvalUnsubscribe = this.approvalUnsubscribe;
        this.approvalUnsubscribe = undefined;
        approvalUnsubscribe?.();
        if (!client) {
            this.clientPromise = undefined;
            this.approvalContexts.clear();
            return;
        }
        await Promise.allSettled(this.sessions.values().filter(session => session.running).map(async (session) => {
            const sessionId = session.sessionId;
            if (!sessionId) {
                return;
            }
            const nativeSessionId = Number.parseInt(sessionId, 10);
            if (!Number.isNaN(nativeSessionId)) {
                await client.terminateSession({ sessionId: nativeSessionId });
            }
        }));
        await client.shutdown();
        this.client = undefined;
        this.clientPromise = undefined;
        this.approvalContexts.clear();
    }
    async exec(input, signal) {
        if (!input.cmd.trim()) {
            throw new Error('exec requires a non-empty cmd string.');
        }
        const client = await this.getClient();
        const itemId = randomUUID();
        const normalized = normalizeExecInput(this.options, input);
        const approvalContext = {
            itemId,
            sandboxPermissions: normalized.sandboxPermissions,
        };
        const result = await this.runWithApprovalContext(approvalContext, () => (client.exec(this.buildExecParams(normalized, itemId), signal)));
        return this.consumeExecResult(normalized, result);
    }
    async writeToSession(input, signal) {
        const session = this.sessions.get(input.sessionId);
        if (!session) {
            throw new TypeError(`Unknown shell session "${input.sessionId}".`);
        }
        const sessionId = session.sessionId;
        if (!sessionId) {
            throw new TypeError(`Shell session "${input.sessionId}" does not have a native process id.`);
        }
        const nativeSessionId = Number.parseInt(sessionId, 10);
        if (Number.isNaN(nativeSessionId)) {
            throw new TypeError(`Shell session "${input.sessionId}" has an invalid native process id.`);
        }
        const client = await this.getClient();
        const itemId = randomUUID();
        const approvalContext = {
            itemId,
            sandboxPermissions: session.sandboxPermissions,
        };
        const result = await this.runWithApprovalContext(approvalContext, () => (client.writeToSession(this.buildWriteParams(input, itemId, nativeSessionId), signal)));
        const updatedSession = this.sessions.appendResult(sessionId, result);
        if (!updatedSession) {
            throw new Error(`Shell session "${input.sessionId}" disappeared during update.`);
        }
        return { ...updatedSession };
    }
    async terminateSession(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session) {
            return;
        }
        const nativeSessionId = Number.parseInt(session.sessionId ?? '', 10);
        if (Number.isNaN(nativeSessionId)) {
            return;
        }
        const client = await this.getClient();
        await client.terminateSession({ sessionId: nativeSessionId });
        this.sessions.delete(sessionId);
    }
    getSessionSnapshot(sessionId) {
        const session = this.sessions.get(sessionId);
        return session ? { ...session } : undefined;
    }
    listSessions() {
        return this.sessions.values().map(session => ({ ...session }));
    }
    async getClient() {
        if (!this.clientPromise) {
            this.clientPromise = this.createClient();
        }
        return this.clientPromise;
    }
    async createClient() {
        const resolution = resolveNativeShellBundle({
            ...(this.options.hostBinary ? { hostBinary: this.options.hostBinary } : {}),
            ...(this.options.bridge?.zshBinary ? { zshBinary: this.options.bridge.zshBinary } : {}),
            ...(this.options.bridge?.execveWrapperBinary
                ? { execveWrapperBinary: this.options.bridge.execveWrapperBinary }
                : {}),
            ...(this.options.env ? { env: this.options.env } : {}),
            ...(this.options.cwd ? { cwd: this.options.cwd } : {}),
        });
        if (!resolution) {
            throw new Error('Could not resolve a native sandbox host binary. Set CODEX_SANDBOX_HOST_BINARY or provide hostBinary.');
        }
        const client = new CodexShellHostClient({
            binaryPath: resolution.hostBinary.binaryPath,
            codexHome: this.options.codexHome ?? join(homedir(), '.codex-sandbox'),
            ...(this.options.bridge?.enabled === false || !resolution.bridge ? {} : { bridge: resolution.bridge }),
            ...(this.options.launchArgs ? { launchArgs: this.options.launchArgs } : {}),
            ...(this.options.cwd ? { cwd: this.options.cwd } : {}),
            ...(this.options.env ? { env: this.options.env } : {}),
        });
        await client.start();
        this.approvalUnsubscribe = client.onApprovalRequest((event) => {
            void this.handleApprovalRequest(event);
        });
        this.client = client;
        return client;
    }
    buildExecParams(input, itemId) {
        return {
            itemId,
            cmd: input.cmd,
            cwd: input.cwd,
            tty: input.tty,
            login: input.login,
            shell: input.shell,
            yieldTimeMs: input.yieldTimeMs,
            sandboxPermissions: toHostSandboxPermissions(input.sandboxPermissions),
            ...(input.env ? { env: input.env } : {}),
            ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
            ...(input.maxOutputTokens !== undefined ? { maxOutputTokens: input.maxOutputTokens } : {}),
        };
    }
    buildWriteParams(input, itemId, sessionId) {
        return {
            itemId,
            sessionId,
            yieldTimeMs: input.yieldTimeMs ?? defaultYieldTimeMs,
            ...(input.chars !== undefined ? { chars: input.chars } : {}),
            ...(input.maxOutputTokens !== undefined ? { maxOutputTokens: input.maxOutputTokens } : {}),
        };
    }
    consumeExecResult(input, result) {
        if (result.sessionId && result.exitCode === undefined) {
            const session = this.sessions.createRunningSession({
                sessionId: result.sessionId,
                command: input.cmd,
                cwd: input.cwd,
                sandboxPermissions: input.sandboxPermissions,
                initialChunk: result.output,
            });
            return { ...session };
        }
        return {
            command: input.cmd,
            cwd: input.cwd,
            running: false,
            output: cropOutput(result.output, input.maxOutputTokens),
            latestChunk: result.output,
            ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
        };
    }
    async runWithApprovalContext(context, run) {
        this.approvalContexts.set(context.itemId, context);
        try {
            return await run();
        }
        finally {
            this.approvalContexts.delete(context.itemId);
        }
    }
    async handleApprovalRequest(request) {
        const client = this.client;
        if (!client) {
            return;
        }
        const context = this.approvalContexts.get(request.itemId);
        const decision = await resolveApprovalDecision(this.options.approvalResolver, request, context);
        await client.respondToApproval({
            approvalId: request.approvalId,
            decision,
        });
    }
}
function normalizeExecInput(options, input) {
    return {
        cmd: input.cmd,
        cwd: input.cwd ?? options.cwd ?? process.cwd(),
        ...(input.env ? { env: input.env } : {}),
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        yieldTimeMs: input.yieldTimeMs ?? defaultYieldTimeMs,
        ...(input.maxOutputTokens !== undefined ? { maxOutputTokens: input.maxOutputTokens } : {}),
        tty: input.tty ?? false,
        login: input.login ?? true,
        shell: input.shell ?? options.shell ?? process.env.SHELL ?? '/bin/zsh',
        sandboxPermissions: input.sandboxPermissions ?? 'useDefault',
    };
}
async function resolveApprovalDecision(resolver, request, context) {
    if (resolver) {
        const decision = await resolver(request, context);
        return coerceApprovalDecision(decision, request.availableDecisions, context);
    }
    return defaultApprovalDecision(request.availableDecisions, context);
}
function toHostSandboxPermissions(value) {
    return value === 'requireEscalated' ? 'requireEscalated' : 'useDefault';
}
function cropOutput(value, maxOutputTokens) {
    if (!maxOutputTokens || maxOutputTokens <= 0) {
        return value;
    }
    const maxChars = Math.max(200, maxOutputTokens * 4);
    if (value.length <= maxChars) {
        return value;
    }
    return value.slice(value.length - maxChars);
}
function coerceApprovalDecision(requested, availableDecisions, context) {
    if (isDecisionAllowed(requested, availableDecisions)) {
        return requested;
    }
    return defaultApprovalDecision(availableDecisions, context);
}
function defaultApprovalDecision(availableDecisions, context) {
    const preferred = context?.sandboxPermissions === 'requireEscalated'
        ? ['acceptForSession', 'accept', 'decline', 'cancel']
        : ['decline', 'cancel', 'accept', 'acceptForSession'];
    for (const decision of preferred) {
        if (isDecisionAllowed(decision, availableDecisions)) {
            return decision;
        }
    }
    return 'cancel';
}
function isDecisionAllowed(decision, availableDecisions) {
    return !availableDecisions || availableDecisions.includes(decision);
}
//# sourceMappingURL=adapter.js.map