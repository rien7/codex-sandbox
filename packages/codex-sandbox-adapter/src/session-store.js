const maxCaptureChars = 120_000;
/** Keep interactive session output in one place for the adapter and CLI. */
export class CodexShellSessionStore {
    sessions = new Map();
    createRunningSession(input) {
        const output = appendCappedText('', input.initialChunk);
        const record = {
            sessionId: input.sessionId,
            command: input.command,
            cwd: input.cwd,
            sandboxPermissions: input.sandboxPermissions,
            running: true,
            output,
            latestChunk: input.initialChunk,
        };
        this.sessions.set(input.sessionId, record);
        return record;
    }
    appendResult(sessionId, result) {
        const session = this.sessions.get(sessionId);
        if (!session) {
            return undefined;
        }
        session.latestChunk = result.output;
        if (result.output) {
            session.output = appendCappedText(session.output, result.output);
        }
        if (result.exitCode !== undefined) {
            session.running = false;
            session.exitCode = result.exitCode;
        }
        return session;
    }
    get(sessionId) {
        return this.sessions.get(sessionId);
    }
    values() {
        return [...this.sessions.values()];
    }
    delete(sessionId) {
        this.sessions.delete(sessionId);
    }
}
function appendCappedText(current, chunk) {
    const next = current + chunk;
    if (next.length <= maxCaptureChars) {
        return next;
    }
    return next.slice(next.length - maxCaptureChars);
}
//# sourceMappingURL=session-store.js.map