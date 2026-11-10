//! Everything Jerry knows about JERRY Core, free of any Tauri runtime so it can be unit tested:
//! where JERRY_HOME is, how run/core.json looks, the loopback HTTP client, starting and stopping Core,
//! and which URLs the main window may show.
//!
//! It mirrors packages/platform (jerry-home.ts, core-client.ts, core-runtime.ts) and
//! apps/cli/src/core-commands.ts. The Core token never leaves this module: it is not serialised,
//! not printed by Debug and not handed to any webview.

use std::ffi::OsStr;
use std::fmt;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::Value;
use tauri::Url;

/// core.log is rotated at start once it exceeds this size; one previous generation is kept.
pub const CORE_LOG_MAX_BYTES: u64 = 5 * 1024 * 1024;

/// Short: Core answers on loopback in milliseconds, and the tray must stay responsive.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(2);

/// The task list can be large (analyses, agent runs); this caps what is read of it.
const MAX_RESPONSE_BYTES: u64 = 32 * 1024 * 1024;

/// The shutdown request body: Core writes the requester and reason to core.log.
const SHUTDOWN_BODY: &str = r#"{"requestedBy":"desktop","reason":"Stop in the desktop app"}"#;

// ---------------------------------------------------------------------------------------------
// JERRY_HOME

/// JERRY data directory, resolved exactly like `resolveJerryHome` in packages/platform:
/// JERRY_HOME when it is set and not blank, else %LOCALAPPDATA%\JERRY on Windows
/// (~/.local/share/jerry elsewhere).
pub fn resolve_jerry_home(env: &dyn Fn(&str) -> Option<String>) -> Result<PathBuf, String> {
    if let Some(value) = env("JERRY_HOME") {
        if !value.trim().is_empty() {
            return std::path::absolute(&value).map_err(|error| format!("Cannot resolve JERRY_HOME {value}: {error}"));
        }
    }
    if cfg!(windows) {
        match env("LOCALAPPDATA") {
            Some(local) if !local.trim().is_empty() => Ok(Path::new(&local).join("JERRY")),
            _ => Err("Cannot resolve JERRY_HOME: LOCALAPPDATA is not set. Set JERRY_HOME explicitly.".to_owned()),
        }
    } else {
        match env("HOME") {
            Some(home) if !home.trim().is_empty() => Ok(Path::new(&home).join(".local").join("share").join("jerry")),
            _ => Err("Cannot resolve JERRY_HOME: HOME is not set. Set JERRY_HOME explicitly.".to_owned()),
        }
    }
}

/// JERRY_HOME from the process environment.
pub fn jerry_home_from_env() -> Result<PathBuf, String> {
    resolve_jerry_home(&|name| std::env::var(name).ok())
}

/// The files of JERRY_HOME this app uses; the same layout as `jerryPaths` in packages/platform.
#[derive(Debug, Clone)]
pub struct JerryPaths {
    pub home: PathBuf,
    pub run_dir: PathBuf,
    pub core_info_file: PathBuf,
    /// Present after "jerry core stop" (or Stop Core here): hooks do not restart Core.
    pub autostart_disabled_file: PathBuf,
    pub runtime_core_file: PathBuf,
    pub logs_dir: PathBuf,
    pub core_log_file: PathBuf,
}

impl JerryPaths {
    pub fn new(home: &Path) -> Self {
        let run_dir = home.join("run");
        let logs_dir = home.join("logs");
        Self {
            home: home.to_path_buf(),
            core_info_file: run_dir.join("core.json"),
            autostart_disabled_file: run_dir.join("autostart.disabled"),
            run_dir,
            runtime_core_file: home.join("runtime").join("core").join("core.mjs"),
            core_log_file: logs_dir.join("core.log"),
            logs_dir,
        }
    }
}

/// JERRY never writes into a repository, so JERRY_HOME must not lie inside a Git working tree
/// (`assertJerryHomeOutsideRepositories` in packages/platform).
pub fn assert_home_outside_repositories(home: &Path) -> Result<(), String> {
    let absolute = std::path::absolute(home).map_err(|error| error.to_string())?;
    let mut current = Some(absolute.as_path());
    while let Some(dir) = current {
        if dir.join(".git").exists() {
            return Err(format!(
                "JERRY_HOME ({}) is inside the Git repository {}. JERRY never writes into repositories; set JERRY_HOME to a directory outside any repository.",
                home.display(),
                dir.display()
            ));
        }
        current = dir.parent();
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// run/core.json

/// JERRY_HOME/run/core.json, validated like `isCoreRuntimeInfo` in packages/contracts.
#[derive(Clone, PartialEq, Eq)]
pub struct CoreInfo {
    pub pid: u64,
    pub port: u16,
    pub configured_port: Option<u16>,
    token: String,
    pub started_at: String,
    pub version: String,
}

impl fmt::Debug for CoreInfo {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CoreInfo")
            .field("pid", &self.pid)
            .field("port", &self.port)
            .field("configured_port", &self.configured_port)
            .field("token", &"<redacted>")
            .field("started_at", &self.started_at)
            .field("version", &self.version)
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CoreError {
    /// Core is not running, not reachable or answered something unreadable.
    Unavailable(String),
    /// Core answered with a non-2xx status.
    Http(u16, String),
}

impl fmt::Display for CoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CoreError::Unavailable(message) => f.write_str(message),
            CoreError::Http(status, message) => write!(f, "JERRY Core responded with HTTP {status}: {message}"),
        }
    }
}

/// A JSON number that is an integer within [min, max] (`Number.isInteger` accepts 5.0 too).
fn integer_in(value: Option<&Value>, min: u64, max: u64) -> Option<u64> {
    let value = value?;
    let number = if let Some(unsigned) = value.as_u64() {
        unsigned
    } else {
        let float = value.as_f64()?;
        if float.fract() != 0.0 || float < 0.0 || float > 9_007_199_254_740_991.0 {
            return None;
        }
        float as u64
    };
    (min..=max).contains(&number).then_some(number)
}

fn is_token(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$` and a plausible calendar date and time.
pub fn is_iso_date_time(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() < 20 || bytes[bytes.len() - 1] != b'Z' {
        return false;
    }
    let digits = |range: std::ops::Range<usize>| bytes[range].iter().all(u8::is_ascii_digit);
    if !(digits(0..4) && bytes[4] == b'-' && digits(5..7) && bytes[7] == b'-' && digits(8..10) && bytes[10] == b'T')
        || !(digits(11..13) && bytes[13] == b':' && digits(14..16) && bytes[16] == b':' && digits(17..19))
    {
        return false;
    }
    let rest = &bytes[19..bytes.len() - 1];
    if !rest.is_empty() && !(rest.len() >= 2 && rest[0] == b'.' && rest[1..].iter().all(u8::is_ascii_digit)) {
        return false;
    }
    let number = |range: std::ops::Range<usize>| value[range].parse::<u32>().unwrap_or(u32::MAX);
    let (month, day, hour, minute, second) = (number(5..7), number(8..10), number(11..13), number(14..16), number(17..19));
    (1..=12).contains(&month) && (1..=31).contains(&day) && hour < 24 && minute < 60 && second < 60
}

impl CoreInfo {
    /// Validates a parsed core.json; `None` when its shape is invalid.
    pub fn from_json(value: &Value) -> Option<Self> {
        let object = value.as_object()?;
        let pid = integer_in(object.get("pid"), 1, 9_007_199_254_740_991)?;
        let port = integer_in(object.get("port"), 1, 65535)? as u16;
        let configured_port = match object.get("configuredPort") {
            None => None,
            Some(value) => Some(integer_in(Some(value), 0, 65535)? as u16),
        };
        let token = object.get("token")?.as_str().filter(|token| is_token(token))?.to_owned();
        let started_at = object.get("startedAt")?.as_str().filter(|value| is_iso_date_time(value))?.to_owned();
        let version = object.get("version")?.as_str().filter(|value| !value.is_empty())?.to_owned();
        Some(Self { pid, port, configured_port, token, started_at, version })
    }

    /// The base URL of Core: always loopback, never anything else.
    pub fn origin(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }
}

/// Reads and validates JERRY_HOME/run/core.json (`readCoreRuntimeInfo` in packages/platform).
pub fn read_core_info(home: &Path) -> Result<CoreInfo, CoreError> {
    let file = JerryPaths::new(home).core_info_file;
    let raw = fs::read_to_string(&file)
        .map_err(|_| CoreError::Unavailable(format!("Core runtime file not found at {} (is Core running?)", file.display())))?;
    let parsed: Value = serde_json::from_str(&raw)
        .map_err(|_| CoreError::Unavailable(format!("Core runtime file {} is not valid JSON", file.display())))?;
    CoreInfo::from_json(&parsed).ok_or_else(|| CoreError::Unavailable(format!("Core runtime file {} has an invalid shape", file.display())))
}

// ---------------------------------------------------------------------------------------------
// HTTP client

/// What the app needs of GET /api/v1/status.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoreStatus {
    pub version: String,
    pub pid: u64,
    pub jerry_home: String,
    pub task_count: u64,
}

/// What the app needs of one item of GET /api/v1/tasks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskBrief {
    pub task_id: String,
    pub title: String,
    pub state: String,
}

/// What the app needs of GET /api/v1/usage: whether the user wants the usage bar, and the last
/// known plan windows in whole percent (None: no reading).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct UsageBrief {
    pub show_bar: bool,
    pub five_hour: Option<u32>,
    pub seven_day: Option<u32>,
}

impl UsageBrief {
    /// Reads Core's usage summary; a missing or malformed part counts as no reading.
    pub fn from_json(body: &Value) -> Self {
        let percent = |window: &str| {
            body.get("limits")
                .and_then(|limits| limits.get(window))
                .and_then(|limit| limit.get("pct"))
                .and_then(Value::as_f64)
                .filter(|pct| pct.is_finite())
                .map(|pct| pct.round().clamp(0.0, 100.0) as u32)
        };
        Self {
            show_bar: body.get("collection").and_then(|collection| collection.get("showBar")).and_then(Value::as_bool).unwrap_or(true),
            five_hour: percent("fiveHour"),
            seven_day: percent("sevenDay"),
        }
    }
}

/// JSON over loopback with the bearer token. No proxy (the token would reach it), no redirects,
/// short timeouts, and the host is always 127.0.0.1.
pub struct CoreClient {
    agent: ureq::Agent,
    origin: String,
    authorization: String,
}

impl CoreClient {
    pub fn new(info: &CoreInfo, timeout: Duration) -> Self {
        let config = ureq::Agent::config_builder()
            .proxy(None)
            .max_redirects(0)
            .http_status_as_error(false)
            .timeout_global(Some(timeout))
            .build();
        Self {
            agent: ureq::Agent::new_with_config(config),
            origin: info.origin(),
            authorization: format!("Bearer {}", info.token),
        }
    }

    pub fn origin(&self) -> &str {
        &self.origin
    }

    fn finish(&self, result: Result<ureq::http::Response<ureq::Body>, ureq::Error>) -> Result<Value, CoreError> {
        let mut response = result.map_err(|error| CoreError::Unavailable(format!("Cannot reach JERRY Core: {error}")))?;
        let status = response.status().as_u16();
        let text = response
            .body_mut()
            .with_config()
            .limit(MAX_RESPONSE_BYTES)
            .read_to_string()
            .map_err(|error| CoreError::Unavailable(format!("JERRY Core response could not be read: {error}")))?;
        let body: Value = if text.is_empty() {
            Value::Null
        } else {
            serde_json::from_str(&text).map_err(|_| CoreError::Unavailable("JERRY Core returned a non-JSON response".to_owned()))?
        };
        if !(200..300).contains(&status) {
            let message = body.get("error").and_then(Value::as_str).unwrap_or("no details").to_owned();
            return Err(CoreError::Http(status, message));
        }
        Ok(body)
    }

    fn get(&self, path: &str) -> Result<Value, CoreError> {
        let request = self
            .agent
            .get(format!("{}{}", self.origin, path))
            .header("Authorization", &self.authorization)
            .header("Accept", "application/json");
        self.finish(request.call())
    }

    fn post_json(&self, path: &str, body: &str) -> Result<Value, CoreError> {
        let request = self
            .agent
            .post(format!("{}{}", self.origin, path))
            .header("Authorization", &self.authorization)
            .header("Accept", "application/json")
            .header("Content-Type", "application/json");
        self.finish(request.send(body))
    }

    /// GET /api/v1/status
    pub fn status(&self) -> Result<CoreStatus, CoreError> {
        let body = self.get("/api/v1/status")?;
        let invalid = || CoreError::Unavailable("JERRY Core returned an unexpected status".to_owned());
        if body.get("status").and_then(Value::as_str) != Some("ok") {
            return Err(invalid());
        }
        Ok(CoreStatus {
            version: body.get("version").and_then(Value::as_str).ok_or_else(invalid)?.to_owned(),
            pid: body.get("pid").and_then(Value::as_u64).unwrap_or(0),
            jerry_home: body.get("jerryHome").and_then(Value::as_str).unwrap_or("").to_owned(),
            task_count: body.get("taskCount").and_then(Value::as_u64).unwrap_or(0),
        })
    }

    /// GET /api/v1/tasks: the task summaries; items without an id or state are skipped.
    pub fn tasks(&self) -> Result<Vec<TaskBrief>, CoreError> {
        let body = self.get("/api/v1/tasks")?;
        let items = body.as_array().ok_or_else(|| CoreError::Unavailable("JERRY Core returned an unexpected task list".to_owned()))?;
        Ok(items
            .iter()
            .filter_map(|item| {
                Some(TaskBrief {
                    task_id: item.get("taskId")?.as_str()?.to_owned(),
                    title: item.get("title").and_then(Value::as_str).unwrap_or("").to_owned(),
                    state: item.get("state")?.as_str()?.to_owned(),
                })
            })
            .collect())
    }

    /// GET /api/v1/usage: the plan limits for the tray tooltip. Ok(None) from a Core without usage (404).
    pub fn usage(&self) -> Result<Option<UsageBrief>, CoreError> {
        match self.get("/api/v1/usage") {
            Ok(body) if body.is_object() => Ok(Some(UsageBrief::from_json(&body))),
            Ok(_) => Err(CoreError::Unavailable("JERRY Core returned an unexpected usage summary".to_owned())),
            Err(CoreError::Http(404, _)) => Ok(None),
            Err(error) => Err(error),
        }
    }

    /// POST /api/v1/ui/login-codes: a one-time dashboard login link. Only a link to this Core's own
    /// loopback origin is accepted.
    pub fn login_url(&self) -> Result<String, CoreError> {
        self.login_url_to(None)
    }

    /// A one-time login link that lands on `route` ("#/tasks/JRY-0001") after signing in. Core
    /// validates the route again; one it does not accept, or a Core without landing routes, lands
    /// on the dashboard's root. An invalid route is not sent at all.
    pub fn login_url_to(&self, route: Option<&str>) -> Result<String, CoreError> {
        let body = match route.filter(|route| is_dashboard_route(route)) {
            Some(route) => serde_json::json!({ "next": route }).to_string(),
            None => "{}".to_owned(),
        };
        let body = self.post_json("/api/v1/ui/login-codes", &body)?;
        let url = body.get("url").and_then(Value::as_str).unwrap_or("");
        if !url.starts_with(&format!("{}/", self.origin)) {
            return Err(CoreError::Unavailable("JERRY Core returned a login link to another address".to_owned()));
        }
        Ok(url.to_owned())
    }

    /// POST /api/v1/shutdown, naming the desktop app as the requester so core.log says who stopped Core.
    pub fn shutdown(&self) -> Result<(), CoreError> {
        self.post_json("/api/v1/shutdown", SHUTDOWN_BODY).map(|_| ())
    }
}

// ---------------------------------------------------------------------------------------------
// Start and stop

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StartOutcome {
    /// A Core process was spawned with this PID.
    Spawned(u32),
}

/// Renames core.log to core.log.1 once it exceeds [`CORE_LOG_MAX_BYTES`].
pub fn rotate_log(file: &Path) {
    if fs::metadata(file).map(|meta| meta.len() > CORE_LOG_MAX_BYTES).unwrap_or(false) {
        let mut rotated = file.as_os_str().to_owned();
        rotated.push(".1");
        let _ = fs::rename(file, PathBuf::from(rotated));
    }
}

/// Starts the installed Core (`runtime/core/core.mjs`) detached, like "jerry core start":
/// re-enables automatic starts, then runs `<node> core.mjs` with JERRY_HOME as working directory
/// and environment, output appended to logs/core.log. Does not check whether Core already runs.
pub fn start_core(home: &Path, node: &OsStr) -> Result<StartOutcome, String> {
    assert_home_outside_repositories(home)?;
    let paths = JerryPaths::new(home);
    match fs::remove_file(&paths.autostart_disabled_file) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("Cannot remove {}: {error}", paths.autostart_disabled_file.display())),
    }
    if !paths.runtime_core_file.is_file() {
        return Err(format!(
            "JERRY Core is not installed ({} is missing). Run \"jerry install\" first.",
            paths.runtime_core_file.display()
        ));
    }
    fs::create_dir_all(&paths.logs_dir).map_err(|error| format!("Cannot create {}: {error}", paths.logs_dir.display()))?;
    rotate_log(&paths.core_log_file);
    let mut log = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&paths.core_log_file)
        .map_err(|error| format!("Cannot open {}: {error}", paths.core_log_file.display()))?;
    // Who started Core, in Core's own log format, so core.log tells the starts apart.
    let _ = writeln!(log, "{} starting JERRY Core (desktop app, from pid {})", iso_now(), std::process::id());
    let log_err = log.try_clone().map_err(|error| error.to_string())?;

    let mut command = Command::new(node);
    command
        .arg(&paths.runtime_core_file)
        .current_dir(home)
        .env("JERRY_HOME", home)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(log_err));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
    }
    let child = command.spawn().map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            "Node.js was not found on PATH; JERRY Core needs Node.js 22.13 or newer.".to_owned()
        } else {
            format!("Failed to start JERRY Core: {error}")
        }
    })?;
    // The child is not waited for: it keeps running after this app exits.
    Ok(StartOutcome::Spawned(child.id()))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StopOutcome {
    /// Core accepted the shutdown request.
    Stopped,
    /// No valid core.json: Core was not running.
    NotRunning,
    /// core.json exists but Core did not answer; it is probably already stopped.
    NotAnswering,
}

/// Stops Core like "jerry core stop": writes run/autostart.disabled (so Claude Code sessions do not
/// start Core again), then asks Core to shut down and waits up to `wait` for core.json to go away.
pub fn stop_core(home: &Path, now_iso: &str, wait: Duration) -> Result<StopOutcome, String> {
    let paths = JerryPaths::new(home);
    fs::create_dir_all(&paths.run_dir).map_err(|error| format!("Cannot create {}: {error}", paths.run_dir.display()))?;
    fs::write(&paths.autostart_disabled_file, now_iso)
        .map_err(|error| format!("Cannot write {}: {error}", paths.autostart_disabled_file.display()))?;
    let info = match read_core_info(home) {
        Ok(info) => info,
        Err(_) => return Ok(StopOutcome::NotRunning),
    };
    match CoreClient::new(&info, REQUEST_TIMEOUT).shutdown() {
        Ok(()) => {}
        Err(CoreError::Unavailable(_)) => return Ok(StopOutcome::NotAnswering),
        Err(error) => return Err(error.to_string()),
    }
    let deadline = Instant::now() + wait;
    while Instant::now() < deadline && paths.core_info_file.exists() {
        std::thread::sleep(Duration::from_millis(100));
    }
    Ok(StopOutcome::Stopped)
}

/// The current time as `Date.prototype.toISOString` writes it: 2026-11-06T22:13:15.083Z.
pub fn iso_now() -> String {
    let elapsed = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    iso_from_millis(elapsed.as_millis() as i64)
}

pub fn iso_from_millis(millis: i64) -> String {
    let days = millis.div_euclid(86_400_000);
    let rest = millis.rem_euclid(86_400_000);
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rest / 3_600_000,
        rest / 60_000 % 60,
        rest / 1000 % 60,
        rest % 1000
    )
}

// ---------------------------------------------------------------------------------------------
// Navigation

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Navigation {
    /// Show it in the window.
    Allow,
    /// Open it in the system browser instead.
    External,
    /// Neither: nothing sensible to open.
    Block,
    /// The dashboard asks for the app's own settings (its "Desktop app settings…" link): cancel the
    /// navigation and show the local settings page in the main window instead.
    OpenSettings,
}

/// The address on Core's origin that the dashboard links to for the app's settings.
pub const DESKTOP_SETTINGS_PATH: &str = "/desktop/settings";

/// The dashboard route the settings page returns to when it was opened from the dashboard's Settings.
pub const SETTINGS_RETURN_ROUTE: &str = "#/settings";

/// The local settings page, relative to the app's pages. Opened from the dashboard, it says so, and
/// its Back button returns to the dashboard's Settings instead of the root.
pub fn settings_page(from_dashboard: bool) -> &'static str {
    if from_dashboard {
        "settings.html?from=dashboard"
    } else {
        "settings.html"
    }
}

/// Where the settings page's Back button goes: a dashboard route, or `None` for the dashboard's root.
/// Only the known return route is accepted from the page; anything else lands on the root.
pub fn back_route(requested: Option<&str>) -> Option<&'static str> {
    (requested == Some(SETTINGS_RETURN_ROUTE)).then_some(SETTINGS_RETURN_ROUTE)
}

/// The marker the dashboard looks for in the main window's user agent.
pub const USER_AGENT_MARKER: &str = "JerryDesktop/";

/// WebView2's own user agent with " JerryDesktop/<version>" appended, once.
pub fn user_agent_with_marker(default: &str, version: &str) -> String {
    let default = default.trim_end();
    if default.contains(USER_AGENT_MARKER) {
        return default.to_owned();
    }
    if default.is_empty() {
        return format!("{USER_AGENT_MARKER}{version}");
    }
    format!("{default} {USER_AGENT_MARKER}{version}")
}

/// The app's own pages: tauri://localhost on macOS/Linux, http(s)://tauri.localhost on Windows,
/// or `local_base`'s origin (the dev server's under `tauri dev`).
pub fn is_local_page(url: &Url, local_base: &Url) -> bool {
    let standard = match url.scheme() {
        "tauri" => url.host_str() == Some("localhost"),
        "http" | "https" => url.host_str() == Some("tauri.localhost") && url.username().is_empty() && url.password().is_none(),
        _ => false,
    };
    standard || (url.origin().is_tuple() && url.origin() == local_base.origin())
}

/// Who may call the app's settings commands (get_settings, set_settings, send_test_notification):
/// the app's own pages, and the dashboard of the Core the app knows (its Settings page shows the
/// app's settings inline). Every other command stays for the app's own pages only.
pub fn may_change_settings(url: &Url, core_port: Option<u16>, local_base: &Url) -> bool {
    is_local_page(url, local_base) || is_core_page(url, core_port)
}

/// The dashboard of the running Core: http://127.0.0.1:<port>/...
pub fn is_core_page(url: &Url, core_port: Option<u16>) -> bool {
    match core_port {
        Some(port) => {
            url.scheme() == "http"
                && url.host_str() == Some("127.0.0.1")
                && url.port_or_known_default() == Some(port)
                && url.username().is_empty()
                && url.password().is_none()
        }
        None => false,
    }
}

/// Where a navigation of the main window may go: the app's pages and the current Core's dashboard
/// stay in the window, except the dashboard's link to the app's settings, which opens the local
/// settings window; other web links open in the system browser; everything else is refused.
pub fn navigation_decision(url: &Url, core_port: Option<u16>, local_base: &Url) -> Navigation {
    if is_core_page(url, core_port) && url.path().trim_end_matches('/') == DESKTOP_SETTINGS_PATH {
        return Navigation::OpenSettings;
    }
    if is_local_page(url, local_base) || is_core_page(url, core_port) {
        return Navigation::Allow;
    }
    match url.scheme() {
        "http" | "https" | "mailto" => Navigation::External,
        _ => Navigation::Block,
    }
}

/// The longest dashboard route a login link may carry (Core's limit).
pub const MAX_ROUTE_LENGTH: usize = 200;

/// A dashboard route as Core accepts it after a login: "#/" and then letters, digits and
/// `-_/%.?=&` only, at most 200 characters (Core's `^#\/[A-Za-z0-9\-_\/%.?=&]*$`).
pub fn is_dashboard_route(route: &str) -> bool {
    route.len() <= MAX_ROUTE_LENGTH
        && route.starts_with("#/")
        && route[2..].chars().all(|c| c.is_ascii_alphanumeric() || "-_/%.?=&".contains(c))
}

/// The dashboard of the Core on `port` at `route`: http://127.0.0.1:<port>/#/tasks/JRY-0001.
/// `None` for a route that is not a dashboard route.
pub fn dashboard_url(port: u16, route: &str) -> Option<Url> {
    if !is_dashboard_route(route) {
        return None;
    }
    Url::parse(&format!("http://127.0.0.1:{port}/{route}")).ok()
}

/// What a click on a notification does with the main window (which is shown and focused either way).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClickTarget {
    /// Leave the window as it is: the dashboard is already open and there is no route.
    Show,
    /// The window is on the signed-in dashboard: go to the route there, without a new login.
    Navigate(Url),
    /// Open the dashboard with a fresh login link that lands on the route (or the root).
    Login(Option<String>),
}

/// Decides a notification click from the main window's address, the running Core's port and the
/// notification's route. A route that is not a dashboard route counts as none.
pub fn click_target(current: Option<&Url>, core_port: Option<u16>, route: Option<&str>) -> ClickTarget {
    let route = route.filter(|route| is_dashboard_route(route));
    let on_dashboard = current.is_some_and(|url| is_core_page(url, core_port));
    match (on_dashboard, core_port, route) {
        (true, Some(port), Some(route)) => dashboard_url(port, route).map_or(ClickTarget::Show, ClickTarget::Navigate),
        (true, _, None) => ClickTarget::Show,
        (_, _, route) => ClickTarget::Login(route.map(str::to_owned)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc;

    fn fake_token() -> String {
        "ab".repeat(32)
    }

    fn core_json(port: u16) -> Value {
        serde_json::json!({
            "pid": 4242,
            "port": port,
            "configuredPort": 47823,
            "token": fake_token(),
            "startedAt": "2026-11-06T22:13:15.083Z",
            "version": "0.1.0",
        })
    }

    fn write_core_json(home: &Path, value: &Value) {
        fs::create_dir_all(home.join("run")).unwrap();
        fs::write(home.join("run").join("core.json"), value.to_string()).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn jerry_home_honours_a_non_blank_override() {
        let env: HashMap<&str, &str> = HashMap::from([("JERRY_HOME", r"C:\data\jerry-home"), ("LOCALAPPDATA", r"C:\Users\u\AppData\Local")]);
        let home = resolve_jerry_home(&|name| env.get(name).map(|value| (*value).to_owned())).unwrap();
        assert_eq!(home, PathBuf::from(r"C:\data\jerry-home"));
    }

    #[cfg(windows)]
    #[test]
    fn jerry_home_falls_back_to_localappdata_when_the_override_is_blank() {
        let env: HashMap<&str, &str> = HashMap::from([("JERRY_HOME", "   "), ("LOCALAPPDATA", r"C:\Users\u\AppData\Local")]);
        let home = resolve_jerry_home(&|name| env.get(name).map(|value| (*value).to_owned())).unwrap();
        assert_eq!(home, PathBuf::from(r"C:\Users\u\AppData\Local\JERRY"));
        let none: HashMap<&str, &str> = HashMap::new();
        assert!(resolve_jerry_home(&|name| none.get(name).map(|value| (*value).to_owned())).unwrap_err().contains("LOCALAPPDATA"));
    }

    #[test]
    fn a_relative_override_is_made_absolute() {
        let home = resolve_jerry_home(&|name| (name == "JERRY_HOME").then(|| "relative-home".to_owned())).unwrap();
        assert!(home.is_absolute());
        assert!(home.ends_with("relative-home"));
    }

    #[test]
    fn a_valid_core_json_is_read_and_its_token_stays_out_of_debug_output() {
        let dir = tempfile::tempdir().unwrap();
        write_core_json(dir.path(), &core_json(51000));
        let info = read_core_info(dir.path()).unwrap();
        assert_eq!((info.pid, info.port, info.configured_port), (4242, 51000, Some(47823)));
        assert_eq!(info.origin(), "http://127.0.0.1:51000");
        assert!(!format!("{info:?}").contains(&fake_token()));
    }

    #[test]
    fn invalid_core_json_files_are_rejected() {
        let mutations: Vec<(&str, Value)> = vec![
            ("token", Value::from("AB".repeat(32))),
            ("token", Value::from("ab".repeat(31))),
            ("token", Value::from("zz".repeat(32))),
            ("port", Value::from(0)),
            ("port", Value::from(65536)),
            ("port", Value::from(80.5)),
            ("port", Value::from("47823")),
            ("pid", Value::from(0)),
            ("pid", Value::from(-1)),
            ("configuredPort", Value::Null),
            ("configuredPort", Value::from(70000)),
            ("startedAt", Value::from("yesterday")),
            ("startedAt", Value::from("2026-13-06T22:13:15Z")),
            ("version", Value::from("")),
        ];
        for (field, value) in mutations {
            let mut json = core_json(51000);
            json[field] = value.clone();
            assert!(CoreInfo::from_json(&json).is_none(), "{field} = {value} should be rejected");
        }
        let mut missing = core_json(51000);
        missing.as_object_mut().unwrap().remove("token");
        assert!(CoreInfo::from_json(&missing).is_none());
        let mut no_configured = core_json(51000);
        no_configured.as_object_mut().unwrap().remove("configuredPort");
        assert_eq!(CoreInfo::from_json(&no_configured).unwrap().configured_port, None);

        let dir = tempfile::tempdir().unwrap();
        assert!(matches!(read_core_info(dir.path()), Err(CoreError::Unavailable(message)) if message.contains("not found")));
        fs::create_dir_all(dir.path().join("run")).unwrap();
        fs::write(dir.path().join("run").join("core.json"), "{not json").unwrap();
        assert!(matches!(read_core_info(dir.path()), Err(CoreError::Unavailable(message)) if message.contains("not valid JSON")));
    }

    #[test]
    fn iso_dates_are_written_like_javascript() {
        assert_eq!(iso_from_millis(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_from_millis(1_794_003_195_083), "2026-11-06T22:13:15.083Z");
        assert_eq!(iso_from_millis(951_782_400_000), "2000-02-29T00:00:00.000Z");
        assert!(is_iso_date_time(&iso_now()));
        assert!(is_iso_date_time("2026-11-06T22:13:15Z"));
        assert!(!is_iso_date_time("2026-11-06T22:13:15.Z"));
        assert!(!is_iso_date_time("2026-11-06 22:13:15Z"));
    }

    /// A request as the mock server saw it.
    #[derive(Debug)]
    struct Seen {
        method: String,
        path: String,
        headers: HashMap<String, String>,
        body: String,
    }

    /// A one-thread HTTP server on 127.0.0.1:0. `responses` gets the bound port and returns the
    /// canned answers, one per request; what each request carried is sent to the receiver.
    fn mock_core(responses: impl FnOnce(u16) -> Vec<(u16, String)>) -> (u16, mpsc::Receiver<Seen>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let responses = responses(port);
        let (sender, receiver) = mpsc::channel();
        std::thread::spawn(move || {
            for (status, body) in responses {
                let Ok((stream, _)) = listener.accept() else { return };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut request_line = String::new();
                reader.read_line(&mut request_line).unwrap();
                let mut parts = request_line.split_whitespace();
                let method = parts.next().unwrap_or("").to_owned();
                let path = parts.next().unwrap_or("").to_owned();
                let mut headers = HashMap::new();
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    let line = line.trim_end();
                    if line.is_empty() {
                        break;
                    }
                    if let Some((name, value)) = line.split_once(':') {
                        headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_owned());
                    }
                }
                let length: usize = headers.get("content-length").and_then(|value| value.parse().ok()).unwrap_or(0);
                let mut body_bytes = vec![0; length];
                reader.read_exact(&mut body_bytes).unwrap();
                let _ = sender.send(Seen { method, path, headers, body: String::from_utf8(body_bytes).unwrap() });
                let mut stream = stream;
                let reply = format!(
                    "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                stream.write_all(reply.as_bytes()).unwrap();
                let _ = stream.flush();
            }
        });
        (port, receiver)
    }

    fn info_for(port: u16) -> CoreInfo {
        CoreInfo::from_json(&core_json(port)).unwrap()
    }

    fn assert_authorized(seen: &Seen, port: u16) {
        assert_eq!(seen.headers.get("authorization"), Some(&format!("Bearer {}", fake_token())));
        assert_eq!(seen.headers.get("host"), Some(&format!("127.0.0.1:{port}")));
    }

    /// A port nothing listens on.
    fn closed_port() -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.local_addr().unwrap().port()
    }

    #[test]
    fn status_is_read_with_the_bearer_token() {
        let status = serde_json::json!({
            "status": "ok", "version": "0.1.0", "pid": 4242, "startedAt": "2026-11-06T22:13:15.083Z",
            "jerryHome": "C:\\jerry-home", "taskCount": 3, "sessionCount": 1,
            "database": { "file": "x", "migration": null }
        });
        let (port, seen) = mock_core(|_| vec![(200, status.to_string())]);
        let client = CoreClient::new(&info_for(port), REQUEST_TIMEOUT);
        let status = client.status().unwrap();
        assert_eq!(status, CoreStatus { version: "0.1.0".into(), pid: 4242, jerry_home: "C:\\jerry-home".into(), task_count: 3 });
        let request = seen.recv().unwrap();
        assert_eq!((request.method.as_str(), request.path.as_str()), ("GET", "/api/v1/status"));
        assert_authorized(&request, port);
    }

    #[test]
    fn tasks_are_listed_and_malformed_items_skipped() {
        let tasks = serde_json::json!([
            { "taskId": "JRY-0001", "title": "First", "state": "WAIT_PLAN_APPROVAL", "planVersion": 1 },
            { "taskId": "JRY-0002", "title": "Second", "state": "DONE" },
            { "title": "No id", "state": "DONE" }
        ]);
        let (port, seen) = mock_core(|_| vec![(200, tasks.to_string())]);
        let list = CoreClient::new(&info_for(port), REQUEST_TIMEOUT).tasks().unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0], TaskBrief { task_id: "JRY-0001".into(), title: "First".into(), state: "WAIT_PLAN_APPROVAL".into() });
        let request = seen.recv().unwrap();
        assert_eq!((request.method.as_str(), request.path.as_str()), ("GET", "/api/v1/tasks"));
        assert_authorized(&request, port);
    }

    #[test]
    fn a_login_link_is_requested_and_only_a_loopback_link_accepted() {
        let good_url = |port: u16| format!("http://127.0.0.1:{port}/ui/login?code={}", "cd".repeat(16));
        let (port, seen) = mock_core(|port| {
            vec![
                (200, serde_json::json!({ "url": good_url(port), "expiresAt": "2026-11-06T22:14:15.083Z" }).to_string()),
                (200, serde_json::json!({ "url": "http://example.com/ui/login?code=x", "expiresAt": "2026-11-06T22:14:15.083Z" }).to_string()),
                (200, serde_json::json!({ "url": format!("http://127.0.0.1:{port}.example.com/"), "expiresAt": "2026-11-06T22:14:15.083Z" }).to_string()),
            ]
        });
        let client = CoreClient::new(&info_for(port), REQUEST_TIMEOUT);
        assert_eq!(client.login_url().unwrap(), good_url(port));
        let request = seen.recv().unwrap();
        assert_eq!((request.method.as_str(), request.path.as_str(), request.body.as_str()), ("POST", "/api/v1/ui/login-codes", "{}"));
        assert_eq!(request.headers.get("content-type").map(String::as_str), Some("application/json"));
        assert_authorized(&request, port);
        assert!(client.login_url().is_err(), "a link to another host is refused");
        assert!(client.login_url().is_err(), "a look-alike host is refused");
    }

    #[test]
    fn a_login_link_can_ask_for_a_landing_route() {
        let good_url = |port: u16| format!("http://127.0.0.1:{port}/ui/login?code={}&next=%23%2Ftasks%2FJRY-0001", "cd".repeat(16));
        let answer = |port: u16| (200, serde_json::json!({ "url": good_url(port), "expiresAt": "2026-11-06T22:14:15.083Z" }).to_string());
        let (port, seen) = mock_core(|port| vec![answer(port), answer(port), answer(port)]);
        let client = CoreClient::new(&info_for(port), REQUEST_TIMEOUT);
        assert_eq!(client.login_url_to(Some("#/tasks/JRY-0001")).unwrap(), good_url(port));
        let request = seen.recv().unwrap();
        assert_eq!((request.method.as_str(), request.path.as_str()), ("POST", "/api/v1/ui/login-codes"));
        assert_eq!(serde_json::from_str::<Value>(&request.body).unwrap(), serde_json::json!({ "next": "#/tasks/JRY-0001" }));
        assert_authorized(&request, port);
        // An invalid route is not sent: the link lands on the root.
        client.login_url_to(Some("https://example.com/")).unwrap();
        assert_eq!(seen.recv().unwrap().body, "{}");
        client.login_url_to(None).unwrap();
        assert_eq!(seen.recv().unwrap().body, "{}");
    }

    #[test]
    fn dashboard_routes_are_checked_like_core_does() {
        for good in ["#/", "#/tasks", "#/tasks/JRY-0001", "#/projects/D%3A%5CWork", "#/tasks?filter=waiting&x=1"] {
            assert!(is_dashboard_route(good), "{good}");
        }
        let long = format!("#/{}", "a".repeat(MAX_ROUTE_LENGTH - 1));
        for bad in ["", "#", "#tasks", "/#/tasks", "tasks", "//evil.example", "javascript:alert(1)", "#/tasks/<x>", "#/a b", "#/é", "#/a\r\nb", long.as_str()] {
            assert!(!is_dashboard_route(bad), "{bad:?}");
        }
        assert!(is_dashboard_route(&long[..MAX_ROUTE_LENGTH]));
    }

    #[test]
    fn the_dashboard_url_of_a_route_stays_on_core() {
        let url = dashboard_url(47823, "#/tasks/JRY-0001").unwrap();
        assert_eq!(url.as_str(), "http://127.0.0.1:47823/#/tasks/JRY-0001");
        assert!(is_core_page(&url, Some(47823)));
        assert_eq!(dashboard_url(47823, "#/").unwrap().as_str(), "http://127.0.0.1:47823/#/");
        assert_eq!(dashboard_url(47823, "//evil.example/"), None);
        assert_eq!(dashboard_url(47823, "#/@evil.example"), None);
    }

    #[test]
    fn a_notification_click_navigates_on_the_dashboard_and_logs_in_elsewhere() {
        let local = Url::parse("http://tauri.localhost/index.html").unwrap();
        let dashboard = Url::parse("http://127.0.0.1:47823/#/overview").unwrap();
        let other_core = Url::parse("http://127.0.0.1:47824/").unwrap();
        let route = Some("#/tasks/JRY-0001");
        let navigate = ClickTarget::Navigate(Url::parse("http://127.0.0.1:47823/#/tasks/JRY-0001").unwrap());
        let login = ClickTarget::Login(Some("#/tasks/JRY-0001".to_owned()));

        assert_eq!(click_target(Some(&dashboard), Some(47823), route), navigate);
        assert_eq!(click_target(Some(&local), Some(47823), route), login, "the fallback page signs in first");
        assert_eq!(click_target(Some(&other_core), Some(47823), route), login, "a Core that is gone");
        assert_eq!(click_target(Some(&dashboard), None, route), login, "no Core known");
        assert_eq!(click_target(None, Some(47823), route), login);

        // No route (Core stopped, the test notification): the window as it is, or the dashboard's root.
        assert_eq!(click_target(Some(&dashboard), Some(47823), None), ClickTarget::Show);
        assert_eq!(click_target(Some(&local), None, None), ClickTarget::Login(None));
        // A route that is not a dashboard route counts as none.
        assert_eq!(click_target(Some(&dashboard), Some(47823), Some("https://example.com/")), ClickTarget::Show);
        assert_eq!(click_target(Some(&local), Some(47823), Some("//evil.example")), ClickTarget::Login(None));
    }

    #[test]
    fn shutdown_names_the_desktop_app_as_the_requester() {
        let (port, seen) = mock_core(|_| vec![(202, r#"{"stopping":true}"#.to_owned())]);
        CoreClient::new(&info_for(port), REQUEST_TIMEOUT).shutdown().unwrap();
        let request = seen.recv().unwrap();
        assert_eq!((request.method.as_str(), request.path.as_str()), ("POST", "/api/v1/shutdown"));
        let body: Value = serde_json::from_str(&request.body).unwrap();
        assert_eq!(body["requestedBy"], "desktop");
        assert_eq!(body["reason"], "Stop in the desktop app");
        assert_authorized(&request, port);
    }

    #[test]
    fn the_client_does_not_follow_redirects() {
        // A redirect to another host is not followed: the token must never leave loopback.
        let (port, seen) = mock_core(|_| vec![(302, String::new())]);
        let client = CoreClient::new(&info_for(port), REQUEST_TIMEOUT);
        assert!(matches!(client.status(), Err(CoreError::Http(302, _)) | Err(CoreError::Unavailable(_))));
        assert_eq!(seen.recv().unwrap().path, "/api/v1/status");
        assert!(seen.recv_timeout(Duration::from_millis(200)).is_err(), "exactly one request was made");
        assert_eq!(client.origin(), format!("http://127.0.0.1:{port}"));
    }

    #[test]
    fn http_errors_and_unreachable_core_are_told_apart() {
        let (port, _seen) = mock_core(|_| vec![(401, serde_json::json!({ "error": "Missing or invalid JERRY token" }).to_string())]);
        let client = CoreClient::new(&info_for(port), REQUEST_TIMEOUT);
        assert_eq!(client.status(), Err(CoreError::Http(401, "Missing or invalid JERRY token".into())));

        let client = CoreClient::new(&info_for(closed_port()), Duration::from_millis(500));
        assert!(matches!(client.status(), Err(CoreError::Unavailable(_))));
    }

    #[test]
    fn the_client_only_ever_talks_to_loopback() {
        // core.json carries a port only; the host is fixed.
        let client = CoreClient::new(&info_for(47823), REQUEST_TIMEOUT);
        assert_eq!(client.origin(), "http://127.0.0.1:47823");
    }

    fn temp_home() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        assert_home_outside_repositories(dir.path()).expect("the temp directory must not be inside a repository");
        dir
    }

    #[test]
    fn start_core_reenables_autostart_and_asks_for_jerry_install_without_a_runtime() {
        let home = temp_home();
        let paths = JerryPaths::new(home.path());
        fs::create_dir_all(&paths.run_dir).unwrap();
        fs::write(&paths.autostart_disabled_file, "2026-11-06T22:13:15.083Z").unwrap();
        let error = start_core(home.path(), OsStr::new("node")).unwrap_err();
        assert!(error.contains("jerry install"), "{error}");
        assert!(!paths.autostart_disabled_file.exists(), "the stop marker is removed first, like jerry core start");
    }

    #[test]
    fn start_core_refuses_a_home_inside_a_repository() {
        let outer = temp_home();
        fs::create_dir_all(outer.path().join(".git")).unwrap();
        let home = outer.path().join("jerry-home");
        fs::create_dir_all(&home).unwrap();
        assert!(start_core(&home, OsStr::new("node")).unwrap_err().contains("inside the Git repository"));
    }

    #[test]
    fn start_core_runs_the_runtime_detached_with_jerry_home_and_the_log() {
        if Command::new("node").arg("--version").output().is_err() {
            eprintln!("node is not on PATH; skipping the spawn test");
            return;
        }
        let home = temp_home();
        let paths = JerryPaths::new(home.path());
        fs::create_dir_all(paths.runtime_core_file.parent().unwrap()).unwrap();
        // A stand-in for Core that records where and how it ran, then exits.
        fs::write(
            &paths.runtime_core_file,
            "import fs from 'node:fs';\nconsole.log('fake core says hello');\nfs.writeFileSync('started.json', JSON.stringify({ cwd: process.cwd(), home: process.env.JERRY_HOME }));\n",
        )
        .unwrap();
        fs::create_dir_all(&paths.logs_dir).unwrap();
        fs::write(&paths.core_log_file, vec![b'x'; CORE_LOG_MAX_BYTES as usize + 1]).unwrap();

        let outcome = start_core(home.path(), OsStr::new("node")).unwrap();
        assert!(matches!(outcome, StartOutcome::Spawned(pid) if pid > 0));
        let marker = home.path().join("started.json");
        let deadline = Instant::now() + Duration::from_secs(15);
        while Instant::now() < deadline && !(marker.exists() && fs::read_to_string(&paths.core_log_file).unwrap_or_default().contains("hello")) {
            std::thread::sleep(Duration::from_millis(50));
        }
        let started: Value = serde_json::from_str(&fs::read_to_string(&marker).unwrap()).unwrap();
        let same = |value: &Value| fs::canonicalize(value.as_str().unwrap()).unwrap() == fs::canonicalize(home.path()).unwrap();
        assert!(same(&started["cwd"]) && same(&started["home"]), "{started}");
        let log = fs::read_to_string(&paths.core_log_file).unwrap();
        assert!(log.contains("fake core says hello"));
        // The app names itself as the starter before Core's own output.
        let start_line = log.lines().next().unwrap();
        assert!(start_line.ends_with(&format!(" starting JERRY Core (desktop app, from pid {})", std::process::id())), "{start_line}");
        assert!(log.find("starting JERRY Core").unwrap() < log.find("fake core says hello").unwrap());
        assert_eq!(fs::metadata(home.path().join("logs").join("core.log.1")).unwrap().len(), CORE_LOG_MAX_BYTES + 1, "the big log was rotated");
    }

    #[test]
    fn stop_core_writes_the_marker_even_when_core_is_not_running() {
        let home = temp_home();
        let outcome = stop_core(home.path(), "2026-11-06T22:13:15.083Z", Duration::ZERO).unwrap();
        assert_eq!(outcome, StopOutcome::NotRunning);
        let paths = JerryPaths::new(home.path());
        assert_eq!(fs::read_to_string(paths.autostart_disabled_file).unwrap(), "2026-11-06T22:13:15.083Z");
    }

    #[test]
    fn stop_core_ignores_a_core_that_does_not_answer() {
        let home = temp_home();
        write_core_json(home.path(), &core_json(closed_port()));
        assert_eq!(stop_core(home.path(), "2026-11-06T22:13:15.083Z", Duration::ZERO).unwrap(), StopOutcome::NotAnswering);
        assert!(JerryPaths::new(home.path()).autostart_disabled_file.exists());
    }

    #[test]
    fn stop_core_asks_core_to_shut_down() {
        let home = temp_home();
        let (port, seen) = mock_core(|_| vec![(202, r#"{"stopping":true}"#.to_owned())]);
        write_core_json(home.path(), &core_json(port));
        assert_eq!(stop_core(home.path(), "2026-11-06T22:13:15.083Z", Duration::ZERO).unwrap(), StopOutcome::Stopped);
        let request = seen.recv().unwrap();
        assert_eq!((request.method.as_str(), request.path.as_str()), ("POST", "/api/v1/shutdown"));
        assert_authorized(&request, port);
        assert!(JerryPaths::new(home.path()).autostart_disabled_file.exists());
    }

    #[test]
    fn navigation_keeps_local_pages_and_the_current_core_and_sends_the_rest_out() {
        let base = Url::parse("http://tauri.localhost/").unwrap();
        let decide = |url: &str, port: Option<u16>| navigation_decision(&Url::parse(url).unwrap(), port, &base);
        assert_eq!(decide("http://tauri.localhost/index.html", None), Navigation::Allow);
        assert_eq!(decide("https://tauri.localhost/settings.html", None), Navigation::Allow);
        assert_eq!(decide("tauri://localhost/index.html", None), Navigation::Allow);
        assert_eq!(decide("http://127.0.0.1:47823/ui/login?code=x", Some(47823)), Navigation::Allow);
        assert_eq!(decide("http://127.0.0.1:47823/", Some(51000)), Navigation::External, "an old port is not Core any more");
        assert_eq!(decide("http://127.0.0.1:47823/", None), Navigation::External);
        assert_eq!(decide("https://127.0.0.1:47823/", Some(47823)), Navigation::External);
        assert_eq!(decide("http://localhost:47823/", Some(47823)), Navigation::External);
        assert_eq!(decide("http://user@127.0.0.1:47823/", Some(47823)), Navigation::External);
        assert_eq!(decide("http://127.0.0.1.evil.example:47823/", Some(47823)), Navigation::External);
        assert_eq!(decide("https://github.com/owner/repo", Some(47823)), Navigation::External);
        assert_eq!(decide("mailto:someone@example.com", Some(47823)), Navigation::External);
        assert_eq!(decide("file:///C:/Windows/win.ini", Some(47823)), Navigation::Block);
        assert_eq!(decide("javascript:alert(1)", Some(47823)), Navigation::Block);
        assert_eq!(decide("http://evil.tauri.localhost.example/", None), Navigation::External);
        assert_eq!(decide("data:text/html,hello", None), Navigation::Block);
        assert!(is_local_page(&Url::parse("http://tauri.localhost/").unwrap(), &base));
        assert!(!is_local_page(&Url::parse("http://127.0.0.1:47823/").unwrap(), &base));

        // Under `tauri dev` the pages come from the dev server, whose origin counts as local.
        let dev = Url::parse("http://127.0.0.1:1430/").unwrap();
        assert!(is_local_page(&Url::parse("http://127.0.0.1:1430/settings.html").unwrap(), &dev));
        assert!(!is_local_page(&Url::parse("http://127.0.0.1:1431/settings.html").unwrap(), &dev));
        assert_eq!(navigation_decision(&Url::parse("http://127.0.0.1:1430/index.html").unwrap(), Some(47823), &dev), Navigation::Allow);
    }

    #[test]
    fn only_local_pages_and_the_known_cores_dashboard_may_change_the_settings() {
        let base = Url::parse("http://tauri.localhost/").unwrap();
        let may = |url: &str, port: Option<u16>| may_change_settings(&Url::parse(url).unwrap(), port, &base);
        assert!(may("http://tauri.localhost/settings.html", None));
        assert!(may("http://127.0.0.1:47823/#/settings", Some(47823)));
        assert!(may("http://127.0.0.1:47823/", Some(47823)));
        // Another port, no known Core, another host name, https, credentials or another site: no.
        assert!(!may("http://127.0.0.1:51000/#/settings", Some(47823)));
        assert!(!may("http://127.0.0.1:47823/#/settings", None));
        assert!(!may("http://localhost:47823/#/settings", Some(47823)));
        assert!(!may("https://127.0.0.1:47823/#/settings", Some(47823)));
        assert!(!may("http://user@127.0.0.1:47823/", Some(47823)));
        assert!(!may("https://example.com/", Some(47823)));
    }

    #[test]
    fn the_settings_page_opens_in_the_main_window_and_goes_back_only_to_known_routes() {
        let base = Url::parse("http://tauri.localhost/").unwrap();
        // The page is one of the app's own pages, so the main window may show it.
        for from_dashboard in [true, false] {
            let page = base.join(settings_page(from_dashboard)).unwrap();
            assert!(is_local_page(&page, &base));
            assert_eq!(navigation_decision(&page, Some(47823), &base), Navigation::Allow);
            assert_eq!(page.path(), "/settings.html");
        }
        assert_eq!(base.join(settings_page(true)).unwrap().query(), Some("from=dashboard"));
        assert_eq!(base.join(settings_page(false)).unwrap().query(), None);
        // Back: the dashboard's Settings, or the root; a route the page makes up is not followed.
        assert_eq!(back_route(Some("#/settings")), Some("#/settings"));
        assert!(is_dashboard_route(back_route(Some("#/settings")).unwrap()));
        assert_eq!(back_route(None), None);
        assert_eq!(back_route(Some("#/tasks/JRY-0001")), None);
        assert_eq!(back_route(Some("javascript:alert(1)")), None);
    }

    #[test]
    fn the_dashboards_settings_link_opens_the_local_settings_page() {
        let base = Url::parse("http://tauri.localhost/").unwrap();
        let decide = |url: &str, port: Option<u16>| navigation_decision(&Url::parse(url).unwrap(), port, &base);
        assert_eq!(decide("http://127.0.0.1:47823/desktop/settings", Some(47823)), Navigation::OpenSettings);
        assert_eq!(decide("http://127.0.0.1:47823/desktop/settings/", Some(47823)), Navigation::OpenSettings);
        assert_eq!(decide("http://127.0.0.1:47823/desktop/settings?from=dashboard#x", Some(47823)), Navigation::OpenSettings);
        // Only on the current Core's origin; anything else stays what it was.
        assert_eq!(decide("http://127.0.0.1:47823/desktop/settings", Some(51000)), Navigation::External);
        assert_eq!(decide("http://127.0.0.1:47823/desktop/settings", None), Navigation::External);
        assert_eq!(decide("https://127.0.0.1:47823/desktop/settings", Some(47823)), Navigation::External);
        assert_eq!(decide("http://localhost:47823/desktop/settings", Some(47823)), Navigation::External);
        assert_eq!(decide("http://user@127.0.0.1:47823/desktop/settings", Some(47823)), Navigation::External);
        assert_eq!(decide("https://example.com/desktop/settings", Some(47823)), Navigation::External);
        assert_eq!(decide("http://127.0.0.1:47823/desktop/settings-other", Some(47823)), Navigation::Allow);
        assert_eq!(decide("http://127.0.0.1:47823/desktop", Some(47823)), Navigation::Allow);
        assert_eq!(decide("http://127.0.0.1:47823/#/settings", Some(47823)), Navigation::Allow);
        assert_eq!(decide("http://tauri.localhost/desktop/settings", None), Navigation::Allow);
    }

    #[test]
    fn the_user_agent_keeps_webviews_own_and_gets_the_marker_once() {
        let edge = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0";
        let marked = user_agent_with_marker(edge, "0.1.0");
        assert_eq!(marked, format!("{edge} JerryDesktop/0.1.0"));
        assert_eq!(user_agent_with_marker(&marked, "0.2.0"), marked, "already marked: unchanged");
        assert_eq!(user_agent_with_marker("", "0.1.0"), "JerryDesktop/0.1.0");
    }

    #[test]
    fn usage_is_read_for_the_tooltip_and_a_core_without_it_is_no_error() {
        let summary = serde_json::json!({
            "collection": { "statusline": "on", "telemetry": "on", "showBar": true },
            "limits": {
                "fiveHour": { "pct": 22.6, "resetsAt": null, "readAt": "2026-11-07T10:00:00.000Z", "entrypoint": "cli" },
                "sevenDay": null
            }
        });
        let (port, seen) = mock_core(|_| vec![(200, summary.to_string()), (404, serde_json::json!({ "error": "Not found" }).to_string()), (500, "{}".to_owned())]);
        let client = CoreClient::new(&info_for(port), REQUEST_TIMEOUT);
        assert_eq!(client.usage().unwrap(), Some(UsageBrief { show_bar: true, five_hour: Some(23), seven_day: None }));
        let request = seen.recv().unwrap();
        assert_eq!((request.method.as_str(), request.path.as_str()), ("GET", "/api/v1/usage"));
        assert_authorized(&request, port);
        assert_eq!(client.usage().unwrap(), None, "an older Core answers 404");
        assert!(matches!(client.usage(), Err(CoreError::Http(500, _))));
    }

    #[test]
    fn usage_fields_are_read_defensively() {
        let read = |value: Value| UsageBrief::from_json(&value);
        assert_eq!(read(serde_json::json!({})), UsageBrief { show_bar: true, five_hour: None, seven_day: None });
        assert_eq!(
            read(serde_json::json!({ "collection": { "showBar": false }, "limits": { "fiveHour": { "pct": 130 }, "sevenDay": { "pct": "41" } } })),
            UsageBrief { show_bar: false, five_hour: Some(100), seven_day: None }
        );
        assert_eq!(read(serde_json::json!({ "limits": { "sevenDay": { "pct": -3 } } })).seven_day, Some(0));
    }
}
