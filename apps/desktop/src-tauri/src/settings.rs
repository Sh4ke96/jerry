//! JERRY Desktop's own settings, stored as JSON in the app's config directory (never in JERRY_HOME).
//! Every field has a default, so a file from an older version, a missing file or a corrupt file
//! all load; fields added later simply take their default.

use std::fs;
use std::io;
use std::path::Path;

use serde::{Deserialize, Serialize};

pub const SETTINGS_FILE: &str = "settings.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    /// Start JERRY Desktop (hidden, in the tray) when the user signs in to Windows.
    pub launch_with_windows: bool,
    /// Show the main window when the app starts (other than through autostart).
    pub open_window_on_start: bool,
    /// Master switch for every notification.
    pub notifications_enabled: bool,
    pub plan_waiting: bool,
    pub report_waiting: bool,
    pub fixes_waiting: bool,
    pub task_done: bool,
    pub task_blocked: bool,
    pub core_stopped: bool,
    /// Play the system notification sound.
    pub sound: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            launch_with_windows: false,
            open_window_on_start: true,
            notifications_enabled: true,
            plan_waiting: true,
            report_waiting: true,
            fixes_waiting: true,
            task_done: true,
            task_blocked: true,
            core_stopped: true,
            sound: true,
        }
    }
}

/// Reads the settings; a missing or unreadable file gives the defaults.
pub fn load(file: &Path) -> Settings {
    fs::read_to_string(file)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

/// Writes the settings through a temporary file, so a crash never leaves half a file behind.
pub fn save(file: &Path, settings: &Settings) -> io::Result<()> {
    if let Some(dir) = file.parent() {
        fs::create_dir_all(dir)?;
    }
    let mut temporary = file.as_os_str().to_owned();
    temporary.push(".tmp");
    let json = serde_json::to_string_pretty(settings).map_err(io::Error::other)?;
    fs::write(&temporary, json)?;
    fs::rename(&temporary, file)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_match_the_plan() {
        let settings = Settings::default();
        assert!(!settings.launch_with_windows);
        assert!(settings.open_window_on_start && settings.notifications_enabled && settings.sound);
        assert!(settings.plan_waiting && settings.report_waiting && settings.fixes_waiting);
        assert!(settings.task_done && settings.task_blocked && settings.core_stopped);
    }

    #[test]
    fn a_missing_file_gives_the_defaults() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(load(&dir.path().join(SETTINGS_FILE)), Settings::default());
    }

    #[test]
    fn settings_round_trip_through_a_new_directory() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("nested").join(SETTINGS_FILE);
        let changed = Settings { launch_with_windows: true, sound: false, task_done: false, ..Settings::default() };
        save(&file, &changed).unwrap();
        assert_eq!(load(&file), changed);
        let raw = fs::read_to_string(&file).unwrap();
        assert!(raw.contains("\"launchWithWindows\": true"), "{raw}");
        assert!(!dir.path().join("nested").join("settings.json.tmp").exists());
    }

    #[test]
    fn a_corrupt_file_gives_the_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join(SETTINGS_FILE);
        for corrupt in ["{not json", "[]", "{\"sound\": \"loud\"}", ""] {
            fs::write(&file, corrupt).unwrap();
            assert_eq!(load(&file), Settings::default(), "{corrupt:?}");
        }
    }

    #[test]
    fn missing_and_unknown_fields_are_tolerated() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join(SETTINGS_FILE);
        fs::write(&file, r#"{"sound": false, "someFutureOption": 3}"#).unwrap();
        assert_eq!(load(&file), Settings { sound: false, ..Settings::default() });
    }
}
