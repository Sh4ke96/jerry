//! Jerry: the JERRY dashboard in its own window, a tray icon and notifications.
//! The logic lives in the pure modules (core, notify, settings); this file wires them to Tauri:
//! state, plugins, windows and the commands of the two local pages.

pub mod core;
pub mod notify;
pub mod settings;
mod tray;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Mutex, MutexGuard, PoisonError};

use serde::Serialize;
use tauri::{Manager, RunEvent, Url, Webview};
use tauri_plugin_autostart::ManagerExt as _;

use crate::settings::Settings;

/// Started by Windows at sign-in (autostart): stay in the tray.
pub const HIDDEN_ARG: &str = "--hidden";

/// What the app last learned about Core, for the tray, the pages and the notifications.
#[derive(Debug, Clone, Default)]
pub struct CoreView {
    pub snapshot: notify::Snapshot,
    pub version: Option<String>,
    /// Why Core cannot be reached, in words for the user.
    pub reason: Option<String>,
}

pub struct AppState {
    pub home: Result<PathBuf, String>,
    /// Origin of the app's own pages (http://tauri.localhost/ when installed).
    pub local_base: Url,
    /// Port of the running Core; the main window may show only that dashboard.
    pub core_port: Mutex<Option<u16>>,
    pub settings_file: PathBuf,
    pub settings: Mutex<Settings>,
    /// The user chose Stop Core and has not started it again.
    pub stopped_by_user: AtomicBool,
    pub view: Mutex<CoreView>,
    pub notifier: Mutex<notify::Notifier>,
    /// Wakes the polling thread for an immediate poll.
    pub wake: Mutex<Option<mpsc::Sender<()>>>,
}

/// A poisoned lock only means another thread panicked mid-update; the data is still usable.
pub fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl AppState {
    pub fn poll_now(&self) {
        if let Some(sender) = lock(&self.wake).as_ref() {
            let _ = sender.send(());
        }
    }

    pub fn stopped_by_user(&self) -> bool {
        self.stopped_by_user.load(Ordering::SeqCst)
    }
}

/// The URL the app's own pages are served from, as Tauri resolves `WebviewUrl::App`.
fn local_base(config: &tauri::Config) -> Url {
    if tauri::is_dev() {
        if let Some(url) = config.build.dev_url.clone() {
            return url;
        }
    }
    let base = if cfg!(windows) { "http://tauri.localhost/" } else { "tauri://localhost/" };
    Url::parse(base).expect("static URL")
}

/// Commands answer only the app's own pages, never the dashboard served by Core (which has no
/// capability for them anyway; this is a second lock on the same door).
fn ensure_local(webview: &Webview, state: &AppState) -> Result<(), String> {
    let url = webview.url().map_err(|error| error.to_string())?;
    if core::is_local_page(&url, &state.local_base) {
        Ok(())
    } else {
        Err("This command is only available to Jerry's own pages.".to_owned())
    }
}

/// The settings commands also answer the dashboard of the Core the app knows (its Settings page
/// shows these settings inline): its capability (capabilities/core-dashboard.json) grants only them,
/// and this checks the origin and port again.
fn ensure_settings_caller(webview: &Webview, state: &AppState) -> Result<(), String> {
    let url = webview.url().map_err(|error| error.to_string())?;
    if core::may_change_settings(&url, *lock(&state.core_port), &state.local_base) {
        Ok(())
    } else {
        Err("The Jerry app's settings are only available to its own pages and the dashboard it opened.".to_owned())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CoreInfoView {
    /// running, stopped or unreachable
    state: &'static str,
    status_text: String,
    version: Option<String>,
    app_version: String,
    jerry_home: String,
    reason: Option<String>,
    waiting: usize,
}

#[tauri::command]
fn core_info(app: tauri::AppHandle, webview: Webview, state: tauri::State<'_, AppState>) -> Result<CoreInfoView, String> {
    ensure_local(&webview, &state)?;
    let view = lock(&state.view).clone();
    let snapshot = &view.snapshot;
    let (state_name, status_text) = if snapshot.core_reachable {
        ("running", format!("Running · GUARDED · {} waiting", snapshot.waiting_count()))
    } else if snapshot.stopped_on_purpose() {
        ("stopped", "Stopped".to_owned())
    } else {
        ("unreachable", "Not reachable".to_owned())
    };
    Ok(CoreInfoView {
        state: state_name,
        status_text,
        version: view.version,
        app_version: app.package_info().version.to_string(),
        jerry_home: match &state.home {
            Ok(home) => home.display().to_string(),
            Err(error) => error.clone(),
        },
        reason: view.reason,
        waiting: snapshot.waiting_count(),
    })
}

/// Start Core from the fallback page; on success the main window opens the dashboard.
#[tauri::command]
async fn start_core(app: tauri::AppHandle, webview: Webview) -> Result<String, String> {
    ensure_local(&webview, &app.state::<AppState>())?;
    let handle = app.clone();
    let message = tauri::async_runtime::spawn_blocking(move || tray::start_core_flow(&handle))
        .await
        .map_err(|error| error.to_string())??;
    let handle = app.clone();
    std::thread::spawn(move || tray::open_dashboard(&handle));
    Ok(message)
}

/// Back to the dashboard from a local page: "Try again" on the fallback page, "Back to the
/// dashboard" on the settings page. `route` may only name the dashboard's Settings (where the
/// settings page was opened from); anything else opens the dashboard's root.
#[tauri::command]
async fn retry(app: tauri::AppHandle, webview: Webview, route: Option<String>) -> Result<(), String> {
    ensure_local(&webview, &app.state::<AppState>())?;
    let handle = app.clone();
    let route = core::back_route(route.as_deref());
    tauri::async_runtime::spawn_blocking(move || tray::open_dashboard_at(&handle, route))
        .await
        .map_err(|error| error.to_string())?
}

/// The stored settings, with "launch with Windows" as Windows actually has it.
#[tauri::command]
fn get_settings(app: tauri::AppHandle, webview: Webview, state: tauri::State<'_, AppState>) -> Result<Settings, String> {
    ensure_settings_caller(&webview, &state)?;
    let mut current = lock(&state.settings).clone();
    if let Ok(enabled) = app.autolaunch().is_enabled() {
        current.launch_with_windows = enabled;
    }
    Ok(current)
}

/// Saves the settings and applies "launch with Windows" at once; returns what was really applied.
#[tauri::command]
fn set_settings(app: tauri::AppHandle, webview: Webview, state: tauri::State<'_, AppState>, settings: Settings) -> Result<Settings, String> {
    ensure_settings_caller(&webview, &state)?;
    let autolaunch = app.autolaunch();
    let applied = if settings.launch_with_windows { autolaunch.enable() } else { autolaunch.disable() };
    let mut next = settings;
    next.launch_with_windows = autolaunch.is_enabled().unwrap_or(false);
    settings::save(&state.settings_file, &next).map_err(|error| format!("Cannot save the settings: {error}"))?;
    *lock(&state.settings) = next.clone();
    applied.map_err(|error| format!("Settings saved, but launching with Windows could not be changed: {error}"))?;
    Ok(next)
}

/// A test notification with `sound` (the one chosen on the settings page, also before it is saved)
/// or, without one, the saved sound. A click on it shows the dashboard.
#[tauri::command]
fn send_test_notification(app: tauri::AppHandle, webview: Webview, state: tauri::State<'_, AppState>, sound: Option<String>) -> Result<(), String> {
    ensure_settings_caller(&webview, &state)?;
    let sound = match sound {
        Some(name) => settings::normalize_sound(&serde_json::Value::String(name)),
        None => lock(&state.settings).sound.clone(),
    };
    tray::show_notification(
        &app,
        "🛡️ Jerry test notification",
        "Notifications work. Click one to open the dashboard.",
        settings::toast_sound(&sound),
        None,
    )
}

pub fn run() {
    let hidden_start = std::env::args().any(|arg| arg == HIDDEN_ARG);
    let context = tauri::generate_context!();
    let base = local_base(context.config());

    let app = tauri::Builder::default()
        // First, so a second launch exits before anything else starts.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if !args.iter().any(|arg| arg == HIDDEN_ARG) {
                tray::show_dashboard(app);
            }
        }))
        .plugin(tauri_plugin_opener::Builder::new().open_js_links_on_click(false).build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::Builder::new().arg(HIDDEN_ARG).build())
        .invoke_handler(tauri::generate_handler![core_info, start_core, retry, get_settings, set_settings, send_test_notification])
        .setup(move |app| {
            let config_dir = app.path().app_config_dir()?;
            let settings_file = config_dir.join(settings::SETTINGS_FILE);
            let stored = settings::load(&settings_file);
            let show_window = !hidden_start && stored.open_window_on_start;
            app.manage(AppState {
                home: core::jerry_home_from_env(),
                local_base: base.clone(),
                core_port: Mutex::new(None),
                settings_file,
                settings: Mutex::new(stored),
                stopped_by_user: AtomicBool::new(false),
                view: Mutex::new(CoreView::default()),
                notifier: Mutex::new(notify::Notifier::new()),
                wake: Mutex::new(None),
            });
            tray::create_main_window(app.handle())?;
            tray::build_tray(app.handle())?;
            tray::watch_notifications(app.handle());
            tray::start_polling(app.handle());
            if show_window {
                let handle = app.handle().clone();
                std::thread::spawn(move || tray::open_dashboard(&handle));
            }
            Ok(())
        })
        .build(context)
        .expect("error while building Jerry");

    app.run(|_app, event| {
        // Closing windows never ends the app; only Quit (an explicit exit code) does.
        if let RunEvent::ExitRequested { code: None, api, .. } = event {
            api.prevent_exit();
        }
    });
}
