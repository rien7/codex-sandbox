use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow};
use codex_shell_command::is_dangerous_command::command_might_be_dangerous;
use codex_utils_pty::{ProcessHandle, TerminalSize, combine_output_receivers, spawn_pty_process};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Stdout};
use tokio::process::{Child, Command};
use tokio::sync::{Mutex, broadcast};
use tokio::time::timeout;

#[tokio::main]
async fn main() -> Result<()> {
    let host = HostState::new();
    let mut lines = BufReader::new(tokio::io::stdin()).lines();

    while let Some(line) = lines.next_line().await? {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let request = match serde_json::from_str::<JsonRpcRequest>(trimmed) {
            Ok(request) => request,
            Err(error) => {
                eprintln!("sandbox-host parse error: {error}");
                continue;
            }
        };

        let host = Arc::clone(&host);
        tokio::spawn(async move {
            if let Err(error) = handle_request(host, request).await {
                eprintln!("sandbox-host request error: {error:#}");
            }
        });
    }

    Ok(())
}

async fn handle_request(host: Arc<HostState>, request: JsonRpcRequest) -> Result<()> {
    match request.method.as_str() {
        "initialize" => {
            let result = HostInitializeResponse {
                user_agent: format!("sandbox-unified-exec-host/{}", env!("CARGO_PKG_VERSION")),
                platform_family: std::env::consts::FAMILY.to_string(),
                platform_os: std::env::consts::OS.to_string(),
            };
            host.write_result(request.id, result).await
        }
        "command/exec" => {
            let params = parse_params::<HostExecCommandParams>(request.params)?;
            if host.should_request_approval(&params) {
                let approval_id = format!("approval-{}", params.item_id);
                {
                    let mut approvals = host.pending_approvals.lock().await;
                    approvals.insert(
                        approval_id.clone(),
                        PendingApproval {
                            request_id: request.id,
                            params: params.clone(),
                            started_at: Instant::now(),
                        },
                    );
                }
                let approval_reason = host.approval_reason(&params);
                host.write_notification(ApprovalRequestNotification {
                    method: "item/commandExecution/requestApproval",
                    params: HostApprovalRequest {
                        item_id: params.item_id,
                        approval_id,
                        command: Some(params.cmd.clone()),
                        cwd: Some(params.cwd.clone()),
                        reason: Some(approval_reason),
                        available_decisions: Some(vec![
                            HostApprovalDecision::Accept,
                            HostApprovalDecision::AcceptForSession,
                            HostApprovalDecision::Decline,
                            HostApprovalDecision::Cancel,
                        ]),
                    },
                })
                .await
            } else {
                let host_for_task = Arc::clone(&host);
                tokio::spawn(async move {
                    let response = execute_exec_request(&host_for_task, params, Instant::now()).await;
                    host_for_task.write_exec_response(request.id, response).await
                });
                Ok(())
            }
        }
        "command/writeStdin" => {
            let params = parse_params::<HostWriteStdinParams>(request.params)?;
            let response = host.write_to_session(params).await?;
            host.write_exec_response(request.id, Ok(response)).await
        }
        "command/terminate" => {
            let params = parse_params::<HostTerminateParams>(request.params)?;
            host.terminate_session(params.session_id).await?;
            host.write_result(request.id, Value::Null).await
        }
        "approval/respond" => {
            let params = parse_params::<HostApprovalResponseParams>(request.params)?;
            let pending = {
                let mut approvals = host.pending_approvals.lock().await;
                approvals.remove(&params.approval_id)
            };
            host.write_result(request.id, Value::Null).await?;
            if let Some(pending) = pending {
                if matches!(params.decision, HostApprovalDecision::AcceptForSession) {
                    host.approved_for_process.store(true, Ordering::SeqCst);
                }
                let host_for_task = Arc::clone(&host);
                tokio::spawn(async move {
                    let response = match params.decision {
                        HostApprovalDecision::Accept | HostApprovalDecision::AcceptForSession => {
                            execute_exec_request(&host_for_task, pending.params, pending.started_at).await
                        }
                        HostApprovalDecision::Decline | HostApprovalDecision::Cancel => {
                            Ok(HostExecCommandResult {
                                item_id: pending.params.item_id,
                                session_id: None,
                                exit_code: Some(1),
                                output: format!(
                                    "{}:{}",
                                    params.decision.as_str(),
                                    pending.params.cmd
                                ),
                                chunk_id: host_for_task.next_chunk_id(),
                                wall_time_ms: pending.started_at.elapsed().as_millis() as u64,
                            })
                        }
                    };
                    host_for_task
                        .write_exec_response(pending.request_id, response)
                        .await
                });
            }
            Ok(())
        }
        _ => host
            .write_error(request.id, -32601, format!("Unknown method {}", request.method))
            .await,
    }
}

async fn execute_exec_request(
    host: &Arc<HostState>,
    params: HostExecCommandParams,
    started_at: Instant,
) -> Result<HostExecCommandResult> {
    if params.tty {
        host.start_interactive_session(params, started_at).await
    } else {
        host.run_buffered_command(params, started_at).await
    }
}

fn parse_params<TValue: for<'de> Deserialize<'de>>(value: Value) -> Result<TValue> {
    serde_json::from_value(value).context("invalid request params")
}

#[derive(Debug, Deserialize)]
struct JsonRpcRequest {
    id: Value,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct JsonRpcResponse<TResult: Serialize> {
    id: Value,
    result: TResult,
}

#[derive(Debug, Serialize)]
struct JsonRpcErrorResponse {
    id: Value,
    error: JsonRpcErrorShape,
}

#[derive(Debug, Serialize)]
struct JsonRpcErrorShape {
    code: i32,
    message: String,
}

#[derive(Debug, Serialize)]
struct ApprovalRequestNotification {
    method: &'static str,
    params: HostApprovalRequest,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum HostSandboxPermissions {
    UseDefault,
    RequireEscalated,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum HostApprovalDecision {
    Accept,
    AcceptForSession,
    Decline,
    Cancel,
}

impl HostApprovalDecision {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Accept => "accept",
            Self::AcceptForSession => "acceptForSession",
            Self::Decline => "decline",
            Self::Cancel => "cancel",
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostExecCommandParams {
    item_id: String,
    cmd: String,
    cwd: String,
    env: Option<HashMap<String, String>>,
    timeout_ms: Option<u64>,
    tty: bool,
    login: bool,
    shell: String,
    yield_time_ms: u64,
    max_output_tokens: Option<usize>,
    sandbox_permissions: HostSandboxPermissions,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostWriteStdinParams {
    item_id: String,
    session_id: i32,
    chars: Option<String>,
    yield_time_ms: u64,
    max_output_tokens: Option<usize>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostTerminateParams {
    session_id: i32,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostApprovalResponseParams {
    approval_id: String,
    decision: HostApprovalDecision,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HostInitializeResponse {
    user_agent: String,
    platform_family: String,
    platform_os: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HostExecCommandResult {
    item_id: String,
    session_id: Option<String>,
    exit_code: Option<i32>,
    output: String,
    chunk_id: String,
    wall_time_ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HostApprovalRequest {
    item_id: String,
    approval_id: String,
    command: Option<String>,
    cwd: Option<String>,
    reason: Option<String>,
    available_decisions: Option<Vec<HostApprovalDecision>>,
}

#[derive(Debug)]
struct PendingApproval {
    request_id: Value,
    params: HostExecCommandParams,
    started_at: Instant,
}

#[derive(Debug)]
struct SessionHandle {
    process: ProcessHandle,
    output_rx: Mutex<broadcast::Receiver<Vec<u8>>>,
}

#[derive(Debug)]
struct HostState {
    writer: Mutex<Stdout>,
    sessions: Mutex<HashMap<i32, Arc<SessionHandle>>>,
    pending_approvals: Mutex<HashMap<String, PendingApproval>>,
    next_session_id: AtomicI32,
    next_chunk_id: AtomicU64,
    approved_for_process: AtomicBool,
}

impl HostState {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            writer: Mutex::new(tokio::io::stdout()),
            sessions: Mutex::new(HashMap::new()),
            pending_approvals: Mutex::new(HashMap::new()),
            next_session_id: AtomicI32::new(1),
            next_chunk_id: AtomicU64::new(1),
            approved_for_process: AtomicBool::new(false),
        })
    }

    fn next_chunk_id(&self) -> String {
        format!("chunk-{}", self.next_chunk_id.fetch_add(1, Ordering::SeqCst))
    }

    fn approval_reason(&self, params: &HostExecCommandParams) -> String {
        if matches!(params.sandbox_permissions, HostSandboxPermissions::RequireEscalated) {
            "Command requested escalated sandbox permissions.".to_string()
        } else {
            "Command matched the inline approval policy.".to_string()
        }
    }

    fn should_request_approval(&self, params: &HostExecCommandParams) -> bool {
        if self.approved_for_process.load(Ordering::SeqCst) {
            return false;
        }

        matches!(params.sandbox_permissions, HostSandboxPermissions::RequireEscalated)
            || command_might_be_dangerous(&shell_wrapped_command(params))
    }

    async fn write_result<TResult: Serialize>(&self, id: Value, result: TResult) -> Result<()> {
        self.write_line(&JsonRpcResponse { id, result }).await
    }

    async fn write_exec_response(&self, id: Value, result: Result<HostExecCommandResult>) -> Result<()> {
        match result {
            Ok(result) => self.write_result(id, result).await,
            Err(error) => self.write_error(id, -32000, error.to_string()).await,
        }
    }

    async fn write_error(&self, id: Value, code: i32, message: String) -> Result<()> {
        self.write_line(&JsonRpcErrorResponse {
            id,
            error: JsonRpcErrorShape { code, message },
        })
        .await
    }

    async fn write_notification<TValue: Serialize>(&self, notification: TValue) -> Result<()> {
        self.write_line(&notification).await
    }

    async fn write_line<TValue: Serialize>(&self, value: &TValue) -> Result<()> {
        let mut writer = self.writer.lock().await;
        let encoded = serde_json::to_vec(value)?;
        writer.write_all(&encoded).await?;
        writer.write_all(b"\n").await?;
        writer.flush().await?;
        Ok(())
    }

    async fn run_buffered_command(
        &self,
        params: HostExecCommandParams,
        started_at: Instant,
    ) -> Result<HostExecCommandResult> {
        let child = spawn_shell_command(&params)?;
        let wait_future = child.wait_with_output();
        let output = if let Some(timeout_ms) = params.timeout_ms {
            timeout(Duration::from_millis(timeout_ms), wait_future)
                .await
                .map_err(|_| anyhow!("command timed out after {timeout_ms}ms"))??
        } else {
            wait_future.await?
        };

        let mut rendered = String::from_utf8_lossy(&output.stdout).to_string();
        rendered.push_str(&String::from_utf8_lossy(&output.stderr));

        Ok(HostExecCommandResult {
            item_id: params.item_id,
            session_id: None,
            exit_code: Some(output.status.code().unwrap_or(1)),
            output: truncate_output(rendered, params.max_output_tokens),
            chunk_id: self.next_chunk_id(),
            wall_time_ms: started_at.elapsed().as_millis() as u64,
        })
    }

    async fn start_interactive_session(
        &self,
        params: HostExecCommandParams,
        started_at: Instant,
    ) -> Result<HostExecCommandResult> {
        let env = merged_env(&params.env);
        let args = shell_args(&params.shell, params.login, &params.cmd);
        let spawned = spawn_pty_process(
            &params.shell,
            &args,
            Path::new(&params.cwd),
            &env,
            &None,
            TerminalSize::default(),
        )
        .await?;
        let output_rx = combine_output_receivers(spawned.stdout_rx, spawned.stderr_rx);
        let session = Arc::new(SessionHandle {
            process: spawned.session,
            output_rx: Mutex::new(output_rx),
        });
        let session_id = self.next_session_id.fetch_add(1, Ordering::SeqCst);
        {
            let mut sessions = self.sessions.lock().await;
            sessions.insert(session_id, Arc::clone(&session));
        }

        let (chunk, exit_code) =
            collect_session_output(Arc::clone(&session), params.yield_time_ms, params.max_output_tokens).await?;
        if exit_code.is_some() {
            let mut sessions = self.sessions.lock().await;
            sessions.remove(&session_id);
        }

        Ok(HostExecCommandResult {
            item_id: params.item_id,
            session_id: exit_code.is_none().then(|| session_id.to_string()),
            exit_code,
            output: chunk,
            chunk_id: self.next_chunk_id(),
            wall_time_ms: started_at.elapsed().as_millis() as u64,
        })
    }

    async fn write_to_session(&self, params: HostWriteStdinParams) -> Result<HostExecCommandResult> {
        let session = {
            let sessions = self.sessions.lock().await;
            sessions
                .get(&params.session_id)
                .cloned()
                .ok_or_else(|| anyhow!("unknown session {}", params.session_id))?
        };

        if let Some(chars) = &params.chars {
            session
                .process
                .writer_sender()
                .send(chars.as_bytes().to_vec())
                .await
                .map_err(|_| anyhow!("failed to write to session {}", params.session_id))?;
        }

        let started_at = Instant::now();
        let (chunk, exit_code) =
            collect_session_output(Arc::clone(&session), params.yield_time_ms, params.max_output_tokens).await?;
        if exit_code.is_some() {
            let mut sessions = self.sessions.lock().await;
            sessions.remove(&params.session_id);
        }

        Ok(HostExecCommandResult {
            item_id: params.item_id,
            session_id: exit_code.is_none().then(|| params.session_id.to_string()),
            exit_code,
            output: chunk,
            chunk_id: self.next_chunk_id(),
            wall_time_ms: started_at.elapsed().as_millis() as u64,
        })
    }

    async fn terminate_session(&self, session_id: i32) -> Result<()> {
        let session = {
            let mut sessions = self.sessions.lock().await;
            sessions.remove(&session_id)
        };

        if let Some(session) = session {
            session.process.terminate();
        }

        Ok(())
    }
}

async fn collect_session_output(
    session: Arc<SessionHandle>,
    yield_time_ms: u64,
    max_output_tokens: Option<usize>,
) -> Result<(String, Option<i32>)> {
    let deadline = Instant::now() + Duration::from_millis(yield_time_ms.max(1));
    let mut output = String::new();

    loop {
        let exit_code = current_exit_code(&session);
        {
            let mut receiver = session.output_rx.lock().await;
            loop {
                match receiver.try_recv() {
                    Ok(chunk) => {
                        output.push_str(&String::from_utf8_lossy(&chunk));
                    }
                    Err(broadcast::error::TryRecvError::Empty) => break,
                    Err(broadcast::error::TryRecvError::Closed) => break,
                    Err(broadcast::error::TryRecvError::Lagged(_)) => continue,
                }
            }

            if !output.is_empty() || exit_code.is_some() {
                return Ok((truncate_output(output, max_output_tokens), exit_code));
            }

            let now = Instant::now();
            if now >= deadline {
                return Ok((String::new(), exit_code));
            }

            match timeout(deadline.saturating_duration_since(now), receiver.recv()).await {
                Ok(Ok(chunk)) => {
                    output.push_str(&String::from_utf8_lossy(&chunk));
                }
                Ok(Err(broadcast::error::RecvError::Closed)) => {
                    let exit_code = current_exit_code(&session);
                    return Ok((truncate_output(output, max_output_tokens), exit_code));
                }
                Ok(Err(broadcast::error::RecvError::Lagged(_))) => {}
                Err(_) => {
                    let exit_code = current_exit_code(&session);
                    return Ok((truncate_output(output, max_output_tokens), exit_code));
                }
            }
        }
    }
}

fn current_exit_code(session: &Arc<SessionHandle>) -> Option<i32> {
    if session.process.has_exited() {
        return session.process.exit_code();
    }

    None
}

fn spawn_shell_command(params: &HostExecCommandParams) -> Result<Child> {
    let mut command = Command::new(&params.shell);
    command.args(shell_args(&params.shell, params.login, &params.cmd));
    command.current_dir(&params.cwd);
    command.stdin(std::process::Stdio::piped());
    command.stdout(std::process::Stdio::piped());
    command.stderr(std::process::Stdio::piped());
    command.kill_on_drop(true);

    command.envs(merged_env(&params.env));

    command
        .spawn()
        .with_context(|| format!("failed to spawn shell {}", params.shell))
}

fn shell_args(shell: &str, login: bool, cmd: &str) -> Vec<String> {
    let shell_name = Path::new(shell)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(shell);
    let command_flag = if login && matches!(shell_name, "bash" | "zsh") {
        "-lc"
    } else {
        "-c"
    };

    vec![command_flag.to_string(), cmd.to_string()]
}

fn merged_env(overrides: &Option<HashMap<String, String>>) -> HashMap<String, String> {
    let mut env: HashMap<String, String> = std::env::vars().collect();
    if let Some(overrides) = overrides {
        env.extend(overrides.clone());
    }
    env
}

fn shell_wrapped_command(params: &HostExecCommandParams) -> Vec<String> {
    let mut command = Vec::with_capacity(3);
    command.push(params.shell.clone());
    command.extend(shell_args(&params.shell, params.login, &params.cmd));
    command
}

fn truncate_output(output: String, max_output_tokens: Option<usize>) -> String {
    let Some(limit) = max_output_tokens else {
        return output;
    };
    let max_chars = limit.saturating_mul(8);
    if output.chars().count() <= max_chars {
        return output;
    }

    output
        .chars()
        .skip(output.chars().count().saturating_sub(max_chars))
        .collect()
}
