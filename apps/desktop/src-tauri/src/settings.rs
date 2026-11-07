//! Jerry's own settings, stored as JSON in the app's config directory (never in JERRY_HOME).
//! Every field has a default, so a file from an older version, a missing file or a corrupt file
//! all load; fields added later simply take their default.

use std::fs;
use std::io;
use std::path::Path;

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

pub const SETTINGS_FILE: &str = "settings.json";

/// No sound: the toast is silent.
pub const NO_SOUND: &str = "None";
/// Windows' default notification sound.
pub const DEFAULT_SOUND: &str = "Default";

/// The notification sounds Windows offers to toasts (ms-winsoundevent:Notification.*), by the names
/// tauri-plugin-notification passes on to them. The alarm and call sounds are Windows' looping
/// sounds; the plugin can only ask for them once, so they play once per notification. Windows
/// plays no custom sound file for an app that is not packaged (MSIX), so only these exist.
pub const SOUNDS: [&str; 25] = [
    DEFAULT_SOUND,
    "IM",
    "Mail",
    "Reminder",
    "SMS",
    "Alarm",
    "Alarm2",
    "Alarm3",
    "Alarm4",
    "Alarm5",
    "Alarm6",
    "Alarm7",
    "Alarm8",
    "Alarm9",
    "Alarm10",
    "Call",
    "Call2",
    "Call3",
    "Call4",
    "Call5",
    "Call6",
    "Call7",
    "Call8",
    "Call9",
    "Call10",
];

/// A stored or requested sound as one of the known names: "None", a name from [`SOUNDS`], or the
/// default for anything else. Older versions stored a switch: true is the default sound, false none.
pub fn normalize_sound(value: &Value) -> String {
    match value {
        Value::Bool(true) => DEFAULT_SOUND.to_owned(),
        Value::Bool(false) => NO_SOUND.to_owned(),
        Value::String(name) if name == NO_SOUND || SOUNDS.contains(&name.as_str()) => name.clone(),
        _ => DEFAULT_SOUND.to_owned(),
    }
}

/// The sound a toast asks Windows for; `None` for a silent toast.
pub fn toast_sound(name: &str) -> Option<&'static str> {
    SOUNDS.iter().copied().find(|sound| *sound == name)
}

fn deserialize_sound<'de, D: Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    Value::deserialize(deserializer).map(|value| normalize_sound(&value))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    /// Start Jerry (hidden, in the tray) when the user signs in to Windows.
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
    /// The notification sound: a name from [`SOUNDS`] or [`NO_SOUND`].
    #[serde(deserialize_with = "deserialize_sound")]
    pub sound: String,
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
            sound: DEFAULT_SOUND.to_owned(),
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
        assert!(settings.open_window_on_start && settings.notifications_enabled);
        assert_eq!(settings.sound, DEFAULT_SOUND);
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
        let changed = Settings { launch_with_windows: true, sound: "Alarm3".to_owned(), task_done: false, ..Settings::default() };
        save(&file, &changed).unwrap();
        assert_eq!(load(&file), changed);
        let raw = fs::read_to_string(&file).unwrap();
        assert!(raw.contains("\"launchWithWindows\": true"), "{raw}");
        assert!(raw.contains("\"sound\": \"Alarm3\""), "{raw}");
        assert!(!dir.path().join("nested").join("settings.json.tmp").exists());
    }

    #[test]
    fn a_corrupt_file_gives_the_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join(SETTINGS_FILE);
        for corrupt in ["{not json", "[]", "{\"taskDone\": \"yes\"}", ""] {
            fs::write(&file, corrupt).unwrap();
            assert_eq!(load(&file), Settings::default(), "{corrupt:?}");
        }
    }

    #[test]
    fn missing_and_unknown_fields_are_tolerated() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join(SETTINGS_FILE);
        fs::write(&file, r#"{"sound": "SMS", "someFutureOption": 3}"#).unwrap();
        assert_eq!(load(&file), Settings { sound: "SMS".to_owned(), ..Settings::default() });
    }

    #[test]
    fn the_old_sound_switch_becomes_a_sound_name() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join(SETTINGS_FILE);
        for (stored, sound) in [("true", DEFAULT_SOUND), ("false", NO_SOUND)] {
            fs::write(&file, format!(r#"{{"sound": {stored}, "taskDone": false}}"#)).unwrap();
            assert_eq!(load(&file), Settings { sound: sound.to_owned(), task_done: false, ..Settings::default() }, "{stored}");
        }
    }

    #[test]
    fn an_unknown_sound_falls_back_to_the_default_and_keeps_the_rest() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join(SETTINGS_FILE);
        for stored in [r#""loud""#, r#""default""#, r#""C:\\Windows\\Media\\chimes.wav""#, "3", "null", "{}"] {
            fs::write(&file, format!(r#"{{"sound": {stored}, "taskBlocked": false}}"#)).unwrap();
            assert_eq!(load(&file), Settings { task_blocked: false, ..Settings::default() }, "{stored}");
        }
    }

    #[test]
    fn every_known_sound_and_none_is_kept() {
        for name in SOUNDS.iter().chain([&NO_SOUND]) {
            assert_eq!(normalize_sound(&Value::String((*name).to_owned())), *name);
        }
        assert_eq!(SOUNDS.len(), SOUNDS.iter().collect::<std::collections::BTreeSet<_>>().len(), "no duplicates");
    }

    #[test]
    fn only_known_sounds_reach_a_toast() {
        assert_eq!(toast_sound(DEFAULT_SOUND), Some("Default"));
        assert_eq!(toast_sound("Call10"), Some("Call10"));
        assert_eq!(toast_sound(NO_SOUND), None, "a silent toast");
        assert_eq!(toast_sound("ms-winsoundevent:Notification.Mail"), None);
        assert_eq!(toast_sound(""), None);
    }

    #[test]
    fn the_settings_page_offers_every_sound() {
        let page = include_str!("../../ui/settings.html");
        for name in SOUNDS.iter().chain([&NO_SOUND]) {
            assert!(page.contains(&format!(r#"<option value="{name}">"#)), "{name} is missing from settings.html");
        }
    }
}
