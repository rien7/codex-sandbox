export function isJsonRpcResponse(value) {
    if (!value || typeof value !== 'object') {
        return false;
    }
    return 'result' in value || 'error' in value;
}
//# sourceMappingURL=protocol.js.map