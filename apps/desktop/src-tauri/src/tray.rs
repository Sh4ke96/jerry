//! The tray icon and its menu, the two windows, polling Core and showing notifications.
//! Anything that talks to Core over HTTP runs off the main thread.

use std::ffi::OsStr;
use std::sync::atomic::Ordering;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use tauri::image::Image;
use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, Url, WebviewWindow, WebviewWindowBuilder, WindowEvent, Wry};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

use crate::core::{self, CoreClient, Navigation, REQUEST_TIMEOUT};
use crate::notify::{self, Snapshot, TaskEntry};
use crate::settings;
use crate::{lock, AppState, CoreView};

pub const MAIN: &str = "main";
pub const SETTINGS: &str = "settings";
const TRAY_ID: &str = "jerry";
const POLL_INTERVAL: Duration = Duration::from_secs(15);

/// The menu entries whose state follows Core.
struct TrayItems {
    start: MenuItem<Wry>,
    stop: MenuItem<Wry>,
}

// ---------------------------------------------------------------------------------------------
// Windows

fn window_config(app: &AppHandle, label: &str) -> tauri::Result<tauri::utils::config::WindowConfig> {
    app.config()
        .app
        .windows
        .iter()
        .find(|window| window.label == label)
        .cloned()
        .ok_or_else(|| tauri::Error::WindowNotFound)
}

/// Decides a navigation of one of the app's windows; links that leave go to the system browser.
fn filter_navigation(app: &AppHandle, url: &Url, allow_core: bool) -> bool {
    let state = app.state::<AppState>();
    let port = if allow_core { *lock(&state.core_port) } else { None };
    match core::navigation_decision(url, port, &state.local_base) {
        Navigation::Allow => true,
        Navigation::External => {
            let _ = app.opener().open_url(url.as_str(), None::<&str>);
            false
        }
        Navigation::Block => false,
        Navigation::OpenSettings => {
            open_settings(app);
            false
        }
    }
}

/// Appends " JerryDesktop/<version>" to WebView2's own user agent, so the dashboard knows it runs
/// in the app (it then offers "Desktop app settings…"). Read from WebView2 rather than written
/// out, so the browser's real user agent stays in front. Takes effect from the next navigation.
#[cfg(windows)]
fn mark_user_agent(window: &WebviewWindow, version: String) {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings2;
    use windows_core::{Interface, HSTRING, PWSTR};

    let _ = window.with_webview(move |webview| {
        // SAFETY: plain COM calls on the webview's own controller, on the thread Tauri runs this
        // closure on (the webview's UI thread); the returned string is freed by take_pwstr.
        unsafe {
            let Ok(settings) = webview.controller().CoreWebView2().and_then(|core| core.Settings()) else {
                return;
            };
            let Ok(settings) = settings.cast::<ICoreWebView2Settings2>() else {
                return;
            };
            let mut current = PWSTR::null();
            if settings.UserAgent(&mut current).is_err() {
                return;
            }
            let marked = core::user_agent_with_marker(&webview2_com::take_pwstr(current), &version);
            let _ = settings.SetUserAgent(&HSTRING::from(marked));
        }
    });
}

#[cfg(not(windows))]
fn mark_user_agent(_window: &WebviewWindow, _version: String) {}

fn build_window(app: &AppHandle, label: &str, allow_core: bool) -> tauri::Result<WebviewWindow> {
    let config = window_config(app, label)?;
    let navigation = app.clone();
    let new_window = app.clone();
    WebviewWindowBuilder::from_config(app, &config)?
        .on_navigation(move |url| filter_navigation(&navigation, url, allow_core))
        .on_new_window(move |url, _features| {
            // window.open and target=_blank: never a new app window; web links go to the browser.
            if matches!(url.scheme(), "http" | "https" | "mailto") {
                let _ = new_window.opener().open_url(url.as_str(), None::<&str>);
            }
            NewWindowResponse::Deny
        })
        .build()
}

/// The main window starts hidden on the local page; closing it only hides it.
pub fn create_main_window(app: &AppHandle) -> tauri::Result<()> {
    let window = build_window(app, MAIN, true)?;
    mark_user_agent(&window, app.package_info().version.to_string());
    let hide = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = hide.hide();
        }
    });
    Ok(())
}

pub fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn local_page(app: &AppHandle, page: &str) -> Option<Url> {
    app.state::<AppState>().local_base.join(page).ok()
}

/// Shows the local fallback page ("Core is not reachable") in the main window.
pub fn show_local_index(app: &AppHandle) {
    if let (Some(window), Some(url)) = (app.get_webview_window(MAIN), local_page(app, "index.html")) {
        // Already there: the page refreshes its status itself, and a reload would drop the
        // message it is about to show.
        let on_index = window.url().map(|current| current.origin() == url.origin() && current.path() == url.path()).unwrap_or(false);
        if !on_index {
            let _ = window.navigate(url);
        }
    }
    show_main(app);
}

/// Opens the dashboard with a fresh one-time login link; when Core cannot be reached, the local
/// page says why. Blocking: call it off the main thread.
pub fn open_dashboard(app: &AppHandle) -> Result<(), String> {
    open_dashboard_at(app, None)
}

/// Opens the dashboard with a fresh login link that lands on `route` ("#/tasks/JRY-0001") or,
/// without one, on the dashboard's root. Blocking: call it off the main thread.
pub fn open_dashboard_at(app: &AppHandle, route: Option<&str>) -> Result<(), String> {
    let state = app.state::<AppState>();
    let result = state
        .home
        .clone()
        .and_then(|home| core::read_core_info(&home).map_err(|error| error.to_string()))
        .and_then(|info| {
            *lock(&state.core_port) = Some(info.port);
            CoreClient::new(&info, REQUEST_TIMEOUT).login_url_to(route).map_err(|error| error.to_string())
        })
        .and_then(|link| Url::parse(&link).map_err(|error| error.to_string()));
    match result {
        Ok(url) => {
            if let Some(window) = app.get_webview_window(MAIN) {
                let _ = window.navigate(url);
            }
            show_main(app);
            Ok(())
        }
        Err(reason) => {
            lock(&state.view).reason = Some(reason.clone());
            show_local_index(app);
            Err(reason)
        }
    }
}

/// Shows the settings window, creating it on first use.
pub fn open_settings(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(SETTINGS) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        return;
    }
    // Built off the main thread: creating a webview inside a menu handler can deadlock WebView2.
    let handle = app.clone();
    std::thread::spawn(move || {
        if let Ok(window) = build_window(&handle, SETTINGS, false) {
            let _ = window.set_focus();
        }
    });
}

// ---------------------------------------------------------------------------------------------
// Start and stop

/// Starts Core unless it already answers, then waits up to 10 s for it to become healthy.
/// Blocking: call it off the main thread.
pub fn start_core_flow(app: &AppHandle) -> Result<String, String> {
    let state = app.state::<AppState>();
    let home = state.home.clone()?;
    state.stopped_by_user.store(false, Ordering::SeqCst);
    let healthy = || core::read_core_info(&home).ok().and_then(|info| CoreClient::new(&info, REQUEST_TIMEOUT).status().ok());
    if healthy().is_some() {
        // Like "jerry core start": automatic starts are allowed again either way.
        let _ = std::fs::remove_file(core::JerryPaths::new(&home).autostart_disabled_file);
        state.poll_now();
        return Ok("JERRY Core is already running.".to_owned());
    }
    core::start_core(&home, OsStr::new("node"))?;
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(250));
        if healthy().is_some() {
            state.poll_now();
            return Ok("JERRY Core started.".to_owned());
        }
    }
    state.poll_now();
    Err(format!(
        "JERRY Core did not become healthy within 10 s; see {}",
        core::JerryPaths::new(&home).core_log_file.display()
    ))
}

fn stop_core_confirmed(app: &AppHandle) {
    let state = app.state::<AppState>();
    let Ok(home) = state.home.clone() else { return };
    state.stopped_by_user.store(true, Ordering::SeqCst);
    let result = core::stop_core(&home, &core::iso_now(), Duration::from_secs(5));
    if let Err(error) = result {
        lock(&state.view).reason = Some(error);
    }
    state.poll_now();
}

fn confirm_stop_core(app: &AppHandle) {
    let handle = app.clone();
    app.dialog()
        .message(
            "While JERRY Core is stopped, Claude Code sessions will not start it automatically: it stays \
             stopped until you choose Start Core here (or run \"jerry core start\").\n\n\
             JERRY's hard rules still apply while Core is stopped.",
        )
        .title("Stop JERRY Core?")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom("Stop Core".to_owned(), "Cancel".to_owned()))
        .show(move |confirmed| {
            if confirmed {
                std::thread::spawn(move || stop_core_confirmed(&handle));
            }
        });
}

// ---------------------------------------------------------------------------------------------
// Tray

fn tray_icon_image() -> tauri::Result<Image<'static>> {
    Image::from_bytes(include_bytes!("../icons/32x32.png"))
}

pub fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open dashboard", true, None::<&str>)?;
    let start = MenuItem::with_id(app, "start", "Start Core", false, None::<&str>)?;
    let stop = MenuItem::with_id(app, "stop", "Stop Core", false, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &open,
            &PredefinedMenuItem::separator(app)?,
            &start,
            &stop,
            &PredefinedMenuItem::separator(app)?,
            &settings,
            &quit,
        ],
    )?;
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(tray_icon_image()?)
        .tooltip("Jerry")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(on_menu_event)
        .on_tray_icon_event(on_tray_icon_event)
        .build(app)?;
    app.manage(TrayItems { start, stop });
    Ok(())
}

fn on_menu_event(app: &AppHandle, event: MenuEvent) {
    match event.id().as_ref() {
        "open" => {
            let handle = app.clone();
            std::thread::spawn(move || open_dashboard(&handle));
        }
        "start" => {
            let handle = app.clone();
            std::thread::spawn(move || {
                match start_core_flow(&handle) {
                    Ok(_) => {
                        let _ = open_dashboard(&handle);
                    }
                    Err(error) => {
                        lock(&handle.state::<AppState>().view).reason = Some(error);
                        show_local_index(&handle);
                    }
                }
            });
        }
        "stop" => confirm_stop_core(app),
        "settings" => open_settings(app),
        "quit" => app.exit(0),
        _ => {}
    }
}

/// Shows the main window; opens the dashboard first when the window shows something else.
pub fn show_dashboard(app: &AppHandle) {
    let port = *lock(&app.state::<AppState>().core_port);
    let on_dashboard = app
        .get_webview_window(MAIN)
        .and_then(|window| window.url().ok())
        .is_some_and(|url| core::is_core_page(&url, port));
    if on_dashboard {
        show_main(app);
    } else {
        let handle = app.clone();
        std::thread::spawn(move || open_dashboard(&handle));
    }
}

/// A left click on the tray icon shows the dashboard.
fn on_tray_icon_event(tray: &TrayIcon, event: TrayIconEvent) {
    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
        show_dashboard(tray.app_handle());
    }
}

fn update_tray(app: &AppHandle, snapshot: &Snapshot) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_tooltip(Some(notify::tray_tooltip(snapshot)));
    }
    if let Some(items) = app.try_state::<TrayItems>() {
        let _ = items.start.set_enabled(!snapshot.core_reachable);
        let _ = items.stop.set_enabled(snapshot.core_reachable);
    }
}

// ---------------------------------------------------------------------------------------------
// Polling and notifications

/// One look at Core: its runtime file, status and tasks.
fn gather(state: &AppState) -> CoreView {
    let mut view = CoreView::default();
    view.snapshot.stopped_by_user = state.stopped_by_user();
    let home = match &state.home {
        Ok(home) => home.clone(),
        Err(error) => {
            view.reason = Some(error.clone());
            *lock(&state.core_port) = None;
            return view;
        }
    };
    view.snapshot.autostart_disabled = core::JerryPaths::new(&home).autostart_disabled_file.exists();
    let info = match core::read_core_info(&home) {
        Ok(info) => info,
        Err(error) => {
            view.reason = Some(if view.snapshot.stopped_on_purpose() {
                "JERRY Core was stopped. Choose Start Core to run it again.".to_owned()
            } else {
                error.to_string()
            });
            *lock(&state.core_port) = None;
            return view;
        }
    };
    *lock(&state.core_port) = Some(info.port);
    let client = CoreClient::new(&info, REQUEST_TIMEOUT);
    match client.status() {
        Ok(status) => {
            view.snapshot.core_reachable = true;
            view.version = Some(status.version);
            if let Ok(tasks) = client.tasks() {
                view.snapshot.tasks = Some(
                    tasks
                        .into_iter()
                        .map(|task| (task.task_id, TaskEntry { state: task.state, title: task.title }))
                        .collect(),
                );
            }
            // The plan limits for the tooltip; a Core without usage (404) or a failed read adds none.
            view.snapshot.usage = client.usage().ok().flatten();
        }
        Err(error) => view.reason = Some(error.to_string()),
    }
    view
}

fn poll_once(app: &AppHandle) {
    let state = app.state::<AppState>();
    let view = gather(&state);
    let was_reachable = lock(&state.view).snapshot.core_reachable;
    update_tray(app, &view.snapshot);

    // The dashboard of a Core that went away cannot work: show the local page with the reason.
    if was_reachable && !view.snapshot.core_reachable {
        if let Some(window) = app.get_webview_window(MAIN) {
            let local = window.url().is_ok_and(|url| core::is_local_page(&url, &state.local_base));
            if !local {
                if let Some(url) = local_page(app, "index.html") {
                    let _ = window.navigate(url);
                }
            }
        }
    }

    let settings = lock(&state.settings).clone();
    let events = lock(&state.notifier).observe(&view.snapshot, &settings);
    *lock(&state.view) = view;
    for event in events {
        let _ = show_notification(app, &event.title, &event.body, settings::toast_sound(&settings.sound), event.route().as_deref());
    }
}

/// Polls Core every 15 s, or at once when woken (after Start or Stop Core).
pub fn start_polling(app: &AppHandle) {
    let (sender, receiver) = mpsc::channel();
    *lock(&app.state::<AppState>().wake) = Some(sender);
    let handle = app.clone();
    std::thread::Builder::new()
        .name("core-poll".into())
        .spawn(move || loop {
            poll_once(&handle);
            match receiver.recv_timeout(POLL_INTERVAL) {
                Ok(()) | Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        })
        .expect("cannot start the polling thread");
}

/// The extra field of a notification that holds the dashboard route a click opens.
const ROUTE_EXTRA: &str = "route";

/// A click on a notification shows the main window at the notification's route (Windows reports
/// it only while the toast is on screen, not from the Action Center).
pub fn watch_notifications(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.notification().on_action(move |performed| {
        if performed.action_id() == "tap" {
            let route = performed
                .notification()
                .and_then(|notification| notification.extra().get(ROUTE_EXTRA))
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned);
            let app = handle.clone();
            std::thread::spawn(move || open_from_notification(&app, route.as_deref()));
        }
    });
}

/// Shows and focuses the main window for a notification click: on the signed-in dashboard it goes
/// to the route there; otherwise a fresh login link lands on it (or the fallback page says why
/// Core cannot be reached). Blocking: call it off the main thread.
fn open_from_notification(app: &AppHandle, route: Option<&str>) {
    let port = *lock(&app.state::<AppState>().core_port);
    let window = app.get_webview_window(MAIN);
    let current = window.as_ref().and_then(|window| window.url().ok());
    match core::click_target(current.as_ref(), port, route) {
        core::ClickTarget::Show => show_main(app),
        core::ClickTarget::Navigate(url) => {
            if let Some(window) = window {
                let _ = window.navigate(url);
            }
            show_main(app);
        }
        core::ClickTarget::Login(route) => {
            let _ = open_dashboard_at(app, route.as_deref());
        }
    }
}

/// Shows a toast with `sound` (a name from settings::SOUNDS; `None` is silent). `route` is the
/// dashboard route a click on it opens; without one a click shows the main window as it is.
pub fn show_notification(app: &AppHandle, title: &str, body: &str, sound: Option<&str>, route: Option<&str>) -> Result<(), String> {
    let mut builder = app.notification().builder().title(title).body(body);
    if let Some(sound) = sound {
        builder = builder.sound(sound);
    }
    if let Some(route) = route {
        builder = builder.extra(ROUTE_EXTRA, route);
    }
    builder.show().map_err(|error| error.to_string())
}
