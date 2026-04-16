import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import process from 'node:process';
import { createInterface } from 'node:readline';
import { prepareCodexHome } from './codex-home.js';
import { isJsonRpcResponse } from './protocol.js';
const lineSplitPattern = /\r?\n/u;
/** Own one native sandbox host process and route JSON-RPC requests over stdio. */
export class CodexShellHostClient {
    options;
    approvalEvents = new EventEmitter();
    pendingRequests = new Map();
    child;
    initializePromise;
    nextRequestId = 1;
    stderrLines = [];
    constructor(options) {
        this.options = options;
    }
    async start() {
        if (!this.initializePromise) {
            this.initializePromise = this.startInternal();
        }
        await this.initializePromise;
    }
    async shutdown() {
        const child = this.child;
        this.child = undefined;
        this.initializePromise = undefined;
        for (const pending of this.pendingRequests.values()) {
            pending.reject(new Error('Codex sandbox host shut down before a response arrived.'));
        }
        this.pendingRequests.clear();
        if (!child) {
            return;
        }
        child.kill('SIGTERM');
    }
    async exec(params, signal) {
        await this.start();
        return this.sendRequest('command/exec', params, signal);
    }
    async writeToSession(params, signal) {
        await this.start();
        return this.sendRequest('command/writeStdin', params, signal);
    }
    async terminateSession(params) {
        await this.start();
        await this.sendRequest('command/terminate', params);
    }
    async respondToApproval(params) {
        await this.start();
        await this.sendRequest('approval/respond', params);
    }
    onApprovalRequest(listener) {
        this.approvalEvents.on('approval', listener);
        return () => {
            this.approvalEvents.off('approval', listener);
        };
    }
    async startInternal() {
        await prepareCodexHome({
            codexHome: this.options.codexHome,
            ...(this.options.bridge ? { bridge: this.options.bridge } : {}),
        });
        const child = spawn(this.options.binaryPath, this.options.launchArgs ?? [], {
            cwd: this.options.cwd ?? process.cwd(),
            env: {
                ...process.env,
                ...this.options.env,
                CODEX_HOME: this.options.codexHome,
            },
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        this.child = child;
        this.stderrLines = [];
        child.once('exit', (_code, signal) => {
            this.child = undefined;
            const message = signal
                ? `Codex sandbox host exited from signal ${signal}.`
                : this.stderrLines.length > 0
                    ? `Codex sandbox host exited. Last stderr: ${this.stderrLines.at(-1)}`
                    : 'Codex sandbox host exited.';
            for (const pending of this.pendingRequests.values()) {
                pending.reject(new Error(message));
            }
            this.pendingRequests.clear();
        });
        const stderr = requireDefinedStream(child.stderr, 'stderr');
        stderr.setEncoding('utf8');
        stderr.on('data', (chunk) => {
            for (const line of chunk.split(lineSplitPattern)) {
                if (!line.trim()) {
                    continue;
                }
                this.stderrLines.push(line);
                if (this.stderrLines.length > 20) {
                    this.stderrLines.shift();
                }
            }
        });
        const stdout = createInterface({
            input: requireDefinedStream(child.stdout, 'stdout'),
            crlfDelay: Number.POSITIVE_INFINITY,
        });
        stdout.on('line', line => this.handleStdoutLine(line));
        const initializeResponse = await this.sendRequest('initialize', {});
        if (!initializeResponse.userAgent) {
            throw new Error('Codex sandbox host initialize response is missing userAgent.');
        }
    }
    handleStdoutLine(line) {
        if (!line.trim()) {
            return;
        }
        const message = JSON.parse(line);
        if (isJsonRpcResponse(message)) {
            if (message.id === undefined) {
                return;
            }
            const pending = this.pendingRequests.get(message.id);
            if (!pending) {
                return;
            }
            this.pendingRequests.delete(message.id);
            if (message.error) {
                pending.reject(new Error(formatJsonRpcError(message.error)));
                return;
            }
            pending.resolve(message.result);
            return;
        }
        if (isApprovalRequestNotification(message)) {
            this.approvalEvents.emit('approval', message.params);
        }
    }
    async sendRequest(method, params, signal) {
        const child = this.child;
        if (!child) {
            throw new Error('Codex sandbox host is not running.');
        }
        const id = this.nextRequestId++;
        const payload = { id, method, params };
        const promise = new Promise((resolve, reject) => {
            this.pendingRequests.set(id, {
                resolve: value => resolve(value),
                reject,
            });
        });
        if (signal) {
            signal.addEventListener('abort', () => {
                const pending = this.pendingRequests.get(id);
                if (!pending) {
                    return;
                }
                this.pendingRequests.delete(id);
                pending.reject(signal.reason ?? new Error('Request aborted.'));
            }, { once: true });
        }
        requireDefinedStream(child.stdin, 'stdin').write(`${JSON.stringify(payload)}\n`);
        return promise;
    }
}
function formatJsonRpcError(error) {
    return `${error.message} (code ${error.code})`;
}
function requireDefinedStream(value, name) {
    if (value === null) {
        throw new Error(`Codex sandbox host ${name} stream is not available.`);
    }
    return value;
}
function isApprovalRequestNotification(value) {
    if (!value || typeof value !== 'object') {
        return false;
    }
    return 'method' in value
        && value.method === 'item/commandExecution/requestApproval'
        && 'params' in value;
}
//# sourceMappingURL=client.js.map