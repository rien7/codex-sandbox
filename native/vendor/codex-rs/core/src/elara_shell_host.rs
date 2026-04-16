use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Context;
use anyhow::Result;
use codex_features::Feature;
use codex_login::AuthManager;
use codex_login::CodexAuth;
use codex_models_manager::manager::ModelsManager;
use codex_models_manager::collaboration_mode_presets::CollaborationModesConfig;
use codex_protocol::config_types::ModeKind;
use codex_protocol::config_types::SandboxMode;
use codex_protocol::config_types::Settings;
use codex_protocol::protocol::AgentStatus;
use codex_protocol::protocol::AskForApproval;
use codex_protocol::protocol::Event;
use codex_protocol::protocol::EventMsg;
use codex_protocol::protocol::InitialHistory;
use codex_protocol::protocol::ReviewDecision;
use codex_protocol::protocol::SessionSource;
use codex_tools::ToolName;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value as JsonValue;
use tokio::io::AsyncBufReadExt;
use tokio::io::AsyncWriteExt;
use tokio::io::BufReader;
use tokio::sync::Mutex;
use tokio::sync::watch;

use crate::agent::AgentControl;
use crate::codex::Session;
use crate::codex::SessionConfiguration;
use crate::codex::TurnContext;
use crate::config::ConfigBuilder;
use crate::config::ConfigOverrides;
use crate::exec_policy::ExecPolicyManager;
use crate::function_tool::FunctionCallError;
use crate::mcp::McpManager;
use crate::plugins::PluginsManager;
use crate::skills_watcher::SkillsWatcher;
use crate::tools::context::ExecCommandToolOutput;
use crate::tools::context::ToolInvocation;
use crate::tools::context::ToolPayload;
use crate::tools::handlers::UnifiedExecHandler;
use crate::tools::registry::ToolHandler;
use crate::turn_diff_tracker::TurnDiffTracker;
use crate::SkillsManager;

/**
 * Run the Elara shell host over stdio.
 * The process speaks newline-delimited JSON with a small request/response API.
 */
pub async fn run_stdio_server() -> Result<()> {
    let (runtime, event_rx) = HostRuntime::from_env().await?;
    let writer = Arc::new(Mutex::new(tokio::io::stdout()));
    let event_task = tokio::spawn(run_event_loop(
        Arc::clone(&runtime),
        event_rx,
        Arc::clone(&writer),
    ));

    let stdin = BufReader::new(tokio::io::stdin());
    let mut lines = stdin.lines();

    while let Some(line) = lines.next_line().await? {
        if line.trim().is_empty() {
            continue;
        }

        let response = match serde_json::from_str::<HostClientRequest>(&line) {
            Ok(request) => handle_request(Arc::clone(&runtime), request).await,
            Err(error) => HostServerResponse::error(
                None,
                -32700,
                format!("failed to parse host request: {error}"),
            ),
        };
        write_message(&writer, &response).await?;
    }

    event_task.abort();
    Ok(())
}

struct HostRuntime {
    session: Arc<Session>,
    turn: Arc<TurnContext>,
}

impl HostRuntime {
    async fn from_env() -> Result<(Arc<Self>, async_channel::Receiver<Event>)> {
        let codex_home = std::env::var("CODEX_HOME")
            .context("CODEX_HOME must point at the dedicated shell runtime home")?;
        let cwd = std::env::current_dir().context("resolve current working directory")?;

        let mut config = ConfigBuilder::default()
            .codex_home(PathBuf::from(&codex_home))
            .harness_overrides(ConfigOverrides {
                cwd: Some(cwd.clone()),
                approval_policy: Some(AskForApproval::OnRequest),
                sandbox_mode: Some(SandboxMode::WorkspaceWrite),
                ephemeral: Some(true),
                ..Default::default()
            })
            .fallback_cwd(Some(cwd.clone()))
            .build()
            .await
            .context("load Codex config for shell host")?;

        if config.zsh_path.is_some() && config.main_execve_wrapper_exe.is_some() {
            let _ = config.features.enable(Feature::ShellZshFork);
        }
        let config = Arc::new(config);

        let auth_manager = AuthManager::from_auth_for_testing(CodexAuth::from_api_key(
            "elara-local-shell",
        ));
        let models_manager = Arc::new(ModelsManager::new(
            config.codex_home.to_path_buf(),
            Arc::clone(&auth_manager),
            /*model_catalog*/ None,
            CollaborationModesConfig::default(),
        ));
        let model = ModelsManager::get_model_offline_for_tests(config.model.as_deref());
        let model_info = ModelsManager::construct_model_info_offline_for_tests(
            model.as_str(),
            &config.to_models_manager_config(),
        );
        let collaboration_mode = codex_protocol::config_types::CollaborationMode {
            mode: ModeKind::Default,
            settings: Settings {
                model,
                reasoning_effort: config.model_reasoning_effort,
                developer_instructions: None,
            },
        };
        let base_instructions = config
            .base_instructions
            .clone()
            .unwrap_or_else(|| model_info.get_model_instructions(config.personality));
        let session_configuration = SessionConfiguration::for_embedded_host(
            Arc::clone(&config),
            collaboration_mode,
            base_instructions,
            SessionSource::Exec,
            Some("elara_shell_host".to_string()),
            Some("elara_shell_host".to_string()),
            Some(env!("CARGO_PKG_VERSION").to_string()),
        );
        let (tx_event, rx_event) = async_channel::unbounded();
        let (agent_status_tx, _agent_status_rx) = watch::channel(AgentStatus::PendingInit);
        let exec_policy = Arc::new(
            ExecPolicyManager::load(&config.config_layer_stack)
                .await
                .context("load exec policy")?,
        );
        let plugins_manager = Arc::new(PluginsManager::new(config.codex_home.to_path_buf()));
        let mcp_manager = Arc::new(McpManager::new(Arc::clone(&plugins_manager)));
        let skills_manager = Arc::new(SkillsManager::new(
            config.codex_home.clone(),
            /*bundled_skills_enabled*/ true,
        ));
        let skills_watcher = Arc::new(SkillsWatcher::noop());
        let environment = codex_exec_server::Environment::create(/*exec_server_url*/ None)
            .await
            .context("create exec environment")?;
        let session = Session::new(
            session_configuration,
            Arc::clone(&config),
            Arc::clone(&auth_manager),
            Arc::clone(&models_manager),
            exec_policy,
            tx_event,
            agent_status_tx,
            InitialHistory::New,
            SessionSource::Exec,
            skills_manager,
            plugins_manager,
            mcp_manager,
            skills_watcher,
            AgentControl::default(),
            Some(Arc::new(environment)),
            None,
        )
        .await
        .context("create shell host session")?;
        session.ensure_active_turn_state().await;
        let turn = session
            .create_detached_turn_context("shell_host".to_string())
            .await;

        Ok((Arc::new(Self { session, turn }), rx_event))
    }

    async fn exec_command(&self, request: HostExecCommandParams) -> Result<HostExecCommandResult> {
        let arguments = serde_json::to_string(&serde_json::json!({
            "cmd": request.cmd,
            "workdir": request.cwd,
            "shell": request.shell,
            "login": request.login,
            "tty": request.tty,
            "yield_time_ms": request.yield_time_ms,
            "timeout_ms": request.timeout_ms,
            "max_output_tokens": request.max_output_tokens,
            "env": request.env,
            "sandbox_permissions": request.sandbox_permissions.to_core(),
        }))?;
        let output = UnifiedExecHandler
            .handle(ToolInvocation {
                session: Arc::clone(&self.session),
                turn: Arc::clone(&self.turn),
                tracker: Arc::new(Mutex::new(TurnDiffTracker::new())),
                call_id: request.item_id,
                tool_name: ToolName::plain("exec_command"),
                payload: ToolPayload::Function { arguments },
            })
            .await
            .map_err(map_function_call_error)?;
        Ok(map_exec_output(output))
    }

    async fn write_stdin(&self, request: HostWriteStdinParams) -> Result<HostExecCommandResult> {
        let arguments = serde_json::to_string(&serde_json::json!({
            "session_id": request.session_id,
            "chars": request.chars,
            "yield_time_ms": request.yield_time_ms,
            "max_output_tokens": request.max_output_tokens,
        }))?;
        let output = UnifiedExecHandler
            .handle(ToolInvocation {
                session: Arc::clone(&self.session),
                turn: Arc::clone(&self.turn),
                tracker: Arc::new(Mutex::new(TurnDiffTracker::new())),
                call_id: request.item_id,
                tool_name: ToolName::plain("write_stdin"),
                payload: ToolPayload::Function { arguments },
            })
            .await
            .map_err(map_function_call_error)?;
        Ok(map_exec_output(output))
    }

    async fn terminate_command(&self, session_id: i32) {
        self.session
            .services
            .unified_exec_manager
            .release_process_id(session_id)
            .await;
    }

    async fn respond_to_approval(&self, request: HostApprovalResponseParams) {
        self.session
            .notify_approval(&request.approval_id, request.decision.to_core())
            .await;
    }
}

async fn run_event_loop(
    runtime: Arc<HostRuntime>,
    rx_event: async_channel::Receiver<Event>,
    writer: Arc<Mutex<tokio::io::Stdout>>,
) -> Result<()> {
    while let Ok(event) = rx_event.recv().await {
        match event.msg {
            EventMsg::ExecApprovalRequest(request) => {
                let approval_id = request.effective_approval_id();
                let available_decisions =
                    map_available_decisions(request.effective_available_decisions());
                let notification = HostServerNotification {
                    method: "item/commandExecution/requestApproval",
                    params: HostApprovalRequestParams {
                        item_id: request.call_id.clone(),
                        approval_id,
                        command: Some(shell_join(request.command)),
                        cwd: Some(request.cwd.to_string_lossy().to_string()),
                        reason: request.reason,
                        available_decisions: Some(available_decisions),
                    },
                };
                write_message(&writer, &notification).await?;
            }
            EventMsg::Warning(warning) => {
                eprintln!("elara-shell-host warning: {}", warning.message);
            }
            EventMsg::Error(error) => {
                eprintln!("elara-shell-host error: {}", error.message);
            }
            _ => {}
        }
    }

    runtime.session.interrupt_task().await;
    Ok(())
}

async fn handle_request(
    runtime: Arc<HostRuntime>,
    request: HostClientRequest,
) -> HostServerResponse {
    let result: Result<JsonValue> = match request.method.as_str() {
        "initialize" => serde_json::to_value(HostInitializeResponse {
            user_agent: format!("elara-unified-exec-host/{}", env!("CARGO_PKG_VERSION")),
            platform_family: std::env::consts::FAMILY.to_string(),
            platform_os: std::env::consts::OS.to_string(),
        })
        .map_err(Into::into),
        "command/exec" => {
            let params = match parse_params::<HostExecCommandParams>(&request.params) {
                Ok(params) => params,
                Err(error) => {
                    return HostServerResponse::error(request.id, -32602, error.to_string());
                }
            };
            match runtime.exec_command(params).await {
                Ok(result) => serde_json::to_value(result).map_err(Into::into),
                Err(error) => Err(error),
            }
        }
        "command/writeStdin" => {
            let params = match parse_params::<HostWriteStdinParams>(&request.params) {
                Ok(params) => params,
                Err(error) => {
                    return HostServerResponse::error(request.id, -32602, error.to_string());
                }
            };
            match runtime.write_stdin(params).await {
                Ok(result) => serde_json::to_value(result).map_err(Into::into),
                Err(error) => Err(error),
            }
        }
        "command/terminate" => {
            let params = match parse_params::<HostTerminateParams>(&request.params) {
                Ok(params) => params,
                Err(error) => {
                    return HostServerResponse::error(request.id, -32602, error.to_string());
                }
            };
            runtime.terminate_command(params.session_id).await;
            serde_json::to_value(HostEmptyResult {}).map_err(Into::into)
        }
        "approval/respond" => {
            let params = match parse_params::<HostApprovalResponseParams>(&request.params) {
                Ok(params) => params,
                Err(error) => {
                    return HostServerResponse::error(request.id, -32602, error.to_string());
                }
            };
            runtime.respond_to_approval(params).await;
            serde_json::to_value(HostEmptyResult {}).map_err(Into::into)
        }
        other => Err(anyhow::anyhow!("unsupported host method `{other}`")),
    };

    match result {
        Ok(value) => HostServerResponse::result(request.id, value),
        Err(error) => HostServerResponse::error(
            request.id,
            -32000,
            error.to_string(),
        ),
    }
}

fn parse_params<T>(value: &JsonValue) -> std::result::Result<T, anyhow::Error>
where
    T: for<'de> Deserialize<'de>,
{
    serde_json::from_value::<T>(value.clone())
        .map_err(|error| anyhow::anyhow!("invalid params: {error}"))
}

fn map_exec_output(output: ExecCommandToolOutput) -> HostExecCommandResult {
    let output_text = output.truncated_output();
    HostExecCommandResult {
        item_id: output.event_call_id,
        session_id: output.process_id.map(|value| value.to_string()),
        exit_code: output.exit_code,
        output: output_text,
        chunk_id: output.chunk_id,
        wall_time_ms: output.wall_time.as_millis() as u64,
    }
}

fn map_function_call_error(error: FunctionCallError) -> anyhow::Error {
    anyhow::anyhow!(error.to_string())
}

fn map_available_decisions(decisions: Vec<ReviewDecision>) -> Vec<HostApprovalDecision> {
    decisions
        .into_iter()
        .filter_map(|decision| match decision {
            ReviewDecision::Approved => Some(HostApprovalDecision::Accept),
            ReviewDecision::ApprovedForSession => Some(HostApprovalDecision::AcceptForSession),
            ReviewDecision::Denied => Some(HostApprovalDecision::Decline),
            ReviewDecision::Abort => Some(HostApprovalDecision::Cancel),
            ReviewDecision::ApprovedExecpolicyAmendment { .. }
            | ReviewDecision::NetworkPolicyAmendment { .. }
            | ReviewDecision::TimedOut => None,
        })
        .collect::<Vec<_>>()
}

fn shell_join(command: Vec<String>) -> String {
    command
        .into_iter()
        .map(|part| {
            shlex::try_quote(&part)
                .map(|quoted| quoted.into_owned())
                .unwrap_or(part)
        })
        .collect::<Vec<_>>()
        .join(" ")
}

async fn write_message<T>(writer: &Arc<Mutex<tokio::io::Stdout>>, value: &T) -> Result<()>
where
    T: Serialize,
{
    let mut guard = writer.lock().await;
    let encoded = serde_json::to_vec(value)?;
    guard.write_all(&encoded).await?;
    guard.write_all(b"\n").await?;
    guard.flush().await?;
    Ok(())
}

#[derive(Deserialize)]
struct HostClientRequest {
    id: Option<JsonValue>,
    method: String,
    #[serde(default)]
    params: JsonValue,
}

#[derive(Serialize)]
struct HostServerNotification<T> {
    method: &'static str,
    params: T,
}

#[derive(Serialize)]
struct HostServerResponse {
    #[serde(skip_serializing_if = "Option::is_none")]
    id: Option<JsonValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<JsonValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<HostErrorShape>,
}

impl HostServerResponse {
    fn result(id: Option<JsonValue>, result: JsonValue) -> Self {
        Self {
            id,
            result: Some(result),
            error: None,
        }
    }

    fn error(id: Option<JsonValue>, code: i64, message: String) -> Self {
        Self {
            id,
            result: None,
            error: Some(HostErrorShape { code, message }),
        }
    }
}

#[derive(Serialize)]
struct HostErrorShape {
    code: i64,
    message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HostInitializeResponse {
    user_agent: String,
    platform_family: String,
    platform_os: String,
}

#[derive(Serialize)]
struct HostEmptyResult {}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostExecCommandParams {
    item_id: String,
    cmd: String,
    cwd: String,
    #[serde(default)]
    tty: bool,
    #[serde(default = "default_login")]
    login: bool,
    #[serde(default = "default_shell")]
    shell: String,
    #[serde(default = "default_exec_yield_time_ms")]
    yield_time_ms: u64,
    #[serde(default)]
    timeout_ms: Option<u64>,
    #[serde(default)]
    max_output_tokens: Option<usize>,
    #[serde(default)]
    env: Option<std::collections::HashMap<String, String>>,
    sandbox_permissions: HostSandboxPermissions,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostWriteStdinParams {
    item_id: String,
    session_id: i32,
    #[serde(default)]
    chars: String,
    #[serde(default = "default_write_yield_time_ms")]
    yield_time_ms: u64,
    #[serde(default)]
    max_output_tokens: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostTerminateParams {
    session_id: i32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostApprovalResponseParams {
    approval_id: String,
    decision: HostApprovalDecision,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HostExecCommandResult {
    item_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    exit_code: Option<i32>,
    output: String,
    chunk_id: String,
    wall_time_ms: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HostApprovalRequestParams {
    item_id: String,
    approval_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    available_decisions: Option<Vec<HostApprovalDecision>>,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
enum HostSandboxPermissions {
    UseDefault,
    RequireEscalated,
}

impl HostSandboxPermissions {
    fn to_core(self) -> crate::sandboxing::SandboxPermissions {
        match self {
            Self::UseDefault => crate::sandboxing::SandboxPermissions::UseDefault,
            Self::RequireEscalated => crate::sandboxing::SandboxPermissions::RequireEscalated,
        }
    }
}

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum HostApprovalDecision {
    Accept,
    AcceptForSession,
    Decline,
    Cancel,
}

impl HostApprovalDecision {
    fn to_core(self) -> ReviewDecision {
        match self {
            Self::Accept => ReviewDecision::Approved,
            Self::AcceptForSession => ReviewDecision::ApprovedForSession,
            Self::Decline => ReviewDecision::Denied,
            Self::Cancel => ReviewDecision::Abort,
        }
    }
}

fn default_login() -> bool {
    true
}

fn default_shell() -> String {
    "/bin/zsh".to_string()
}

fn default_exec_yield_time_ms() -> u64 {
    1_000
}

fn default_write_yield_time_ms() -> u64 {
    1_000
}
