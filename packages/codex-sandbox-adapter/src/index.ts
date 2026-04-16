/** High-level adapter API. Most users should start here. */
export { CodexShellAdapter, type CodexShellAdapterRuntime } from './adapter.js'

/** Low-level stdio JSON-RPC client for directly owning one native host process. */
export { CodexShellHostClient, type CodexShellNativeClient } from './client.js'

/** Low-level helpers for default config path resolution and managed config preparation. */
export { getDefaultConfigPath, prepareConfigPath } from './config-path.js'

/** Low-level host protocol shapes used by the native JSON-RPC boundary. */
export type {
  HostApprovalRequest,
  HostApprovalResponseParams,
  HostExecCommandParams,
  HostExecCommandResult,
  HostInitializeResponse,
  HostSandboxPermissions,
  HostTerminateParams,
  HostWriteStdinParams,
  JsonRpcErrorShape,
  JsonRpcId,
} from './protocol.js'

/** Native binary resolution helpers for packaged, repo-local, or explicit assets. */
export {
  getNativePlatformKey,
  resolveNativeHostBinary,
  resolveNativeShellBridge,
  resolveNativeShellBundle,
} from './resolver.js'

/** High-level adapter input, output, approval, and session types. */
export type {
  CodexShellAdapterOptions,
  CodexShellApprovalContext,
  CodexShellApprovalDecision,
  CodexShellApprovalRequest,
  CodexShellApprovalResolver,
  CodexShellBridgeOptions,
  CodexShellExecInput,
  CodexShellResult,
  CodexShellSandboxPermissions,
  CodexShellSessionSnapshot,
  CodexShellWriteInput,
} from './types.js'
