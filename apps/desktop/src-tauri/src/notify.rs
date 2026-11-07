//! Which notifications to show, decided from two consecutive snapshots of Core. Pure: no Tauri,
//! no clock, no I/O, so every rule is unit tested.
//!
//! - A task reaching a waiting or final state is told once per transition (a later transition back
//!   into the same state is told again).
//! - The first time tasks are known is a baseline: nothing per task, at most one summary of what waits.
//! - While Core is unreachable the last known task states are kept, so a reconnect repeats nothing.
//! - Core going from reachable to unreachable is told only when the user did not stop it
//!   (Stop Core here, or "jerry core stop", which leaves run/autostart.disabled).

use std::collections::BTreeMap;

use crate::settings::Settings;

pub const WAIT_PLAN_APPROVAL: &str = "WAIT_PLAN_APPROVAL";
pub const WAIT_IMPLEMENTATION_ACCEPTANCE: &str = "WAIT_IMPLEMENTATION_ACCEPTANCE";
pub const WAIT_REVIEW_FIX_APPROVAL: &str = "WAIT_REVIEW_FIX_APPROVAL";
pub const DONE: &str = "DONE";
pub const BLOCKED: &str = "BLOCKED";

/// The states in which a task waits for the user.
pub const WAITING_STATES: [&str; 3] = [WAIT_PLAN_APPROVAL, WAIT_IMPLEMENTATION_ACCEPTANCE, WAIT_REVIEW_FIX_APPROVAL];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskEntry {
    pub state: String,
    pub title: String,
}

/// What one poll of Core found.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Snapshot {
    /// Task id to state and title; `None` while Core cannot be reached.
    pub tasks: Option<BTreeMap<String, TaskEntry>>,
    pub core_reachable: bool,
    /// The user chose Stop Core in this app and has not started it again.
    pub stopped_by_user: bool,
    /// run/autostart.disabled exists ("jerry core stop" or Stop Core).
    pub autostart_disabled: bool,
}

impl Snapshot {
    pub fn waiting_count(&self) -> usize {
        self.tasks
            .as_ref()
            .map(|tasks| tasks.values().filter(|task| WAITING_STATES.contains(&task.state.as_str())).count())
            .unwrap_or(0)
    }

    /// The user stopped Core on purpose, here or with the CLI.
    pub fn stopped_on_purpose(&self) -> bool {
        self.stopped_by_user || self.autostart_disabled
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EventKind {
    PlanWaiting,
    ReportWaiting,
    FixesWaiting,
    TaskDone,
    TaskBlocked,
    CoreStoppedUnexpectedly,
    /// The first poll found tasks already waiting.
    WaitingSummary,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Event {
    pub kind: EventKind,
    pub task_id: Option<String>,
    pub title: String,
    pub body: String,
}

/// The event a task state calls for, if any.
pub fn kind_for_state(state: &str) -> Option<EventKind> {
    match state {
        WAIT_PLAN_APPROVAL => Some(EventKind::PlanWaiting),
        WAIT_IMPLEMENTATION_ACCEPTANCE => Some(EventKind::ReportWaiting),
        WAIT_REVIEW_FIX_APPROVAL => Some(EventKind::FixesWaiting),
        DONE => Some(EventKind::TaskDone),
        BLOCKED => Some(EventKind::TaskBlocked),
        _ => None,
    }
}

/// Whether the per-type switch allows this kind (the master switch is checked separately).
pub fn kind_enabled(kind: EventKind, settings: &Settings) -> bool {
    match kind {
        EventKind::PlanWaiting => settings.plan_waiting,
        EventKind::ReportWaiting => settings.report_waiting,
        EventKind::FixesWaiting => settings.fixes_waiting,
        EventKind::TaskDone => settings.task_done,
        EventKind::TaskBlocked => settings.task_blocked,
        EventKind::CoreStoppedUnexpectedly => settings.core_stopped,
        EventKind::WaitingSummary => settings.plan_waiting || settings.report_waiting || settings.fixes_waiting,
    }
}

fn task_event(kind: EventKind, task_id: &str, task: &TaskEntry) -> Event {
    let title = match kind {
        EventKind::PlanWaiting => "📋 Plan waiting for your approval",
        EventKind::ReportWaiting => "📄 Implementation report waiting for you",
        EventKind::FixesWaiting => "🛠️ Review fixes waiting for your approval",
        EventKind::TaskDone => "🏁 Task done",
        EventKind::TaskBlocked => "⛔ Task blocked",
        EventKind::CoreStoppedUnexpectedly | EventKind::WaitingSummary => "🛡️ JERRY",
    };
    let body = if task.title.is_empty() { task_id.to_owned() } else { format!("{task_id} · {}", task.title) };
    Event { kind, task_id: Some(task_id.to_owned()), title: title.to_owned(), body }
}

fn short_name(state: &str) -> &'static str {
    match state {
        WAIT_PLAN_APPROVAL => "plan",
        WAIT_IMPLEMENTATION_ACCEPTANCE => "report",
        _ => "fixes",
    }
}

pub fn core_stopped_event() -> Event {
    Event {
        kind: EventKind::CoreStoppedUnexpectedly,
        task_id: None,
        title: "⚠️ JERRY Core stopped unexpectedly".to_owned(),
        body: "JERRY Core no longer answers. Choose Start Core in the JERRY tray menu; the next Claude Code session also starts it.".to_owned(),
    }
}

/// Remembers the previous snapshot and turns the next one into events.
#[derive(Debug, Default)]
pub struct Notifier {
    known_states: Option<BTreeMap<String, String>>,
    core_reachable: Option<bool>,
}

impl Notifier {
    pub fn new() -> Self {
        Self::default()
    }

    /// The events `current` calls for, already filtered by `settings`. Always updates the memory,
    /// also when notifications are switched off, so switching them on later repeats nothing.
    pub fn observe(&mut self, current: &Snapshot, settings: &Settings) -> Vec<Event> {
        let mut events = Vec::new();
        if let Some(tasks) = &current.tasks {
            match &self.known_states {
                None => {
                    let waiting: Vec<(&String, &TaskEntry)> = tasks
                        .iter()
                        .filter(|(_, task)| {
                            WAITING_STATES.contains(&task.state.as_str())
                                && kind_for_state(&task.state).is_some_and(|kind| kind_enabled(kind, settings))
                        })
                        .collect();
                    if !waiting.is_empty() {
                        let mut parts: Vec<String> = waiting.iter().take(5).map(|(id, task)| format!("{id} {}", short_name(&task.state))).collect();
                        if waiting.len() > 5 {
                            parts.push(format!("+{} more", waiting.len() - 5));
                        }
                        let title = if waiting.len() == 1 {
                            "📋 1 decision waiting in JERRY".to_owned()
                        } else {
                            format!("📋 {} decisions waiting in JERRY", waiting.len())
                        };
                        events.push(Event { kind: EventKind::WaitingSummary, task_id: None, title, body: parts.join(" · ") });
                    }
                }
                Some(previous) => {
                    for (task_id, task) in tasks {
                        if previous.get(task_id) == Some(&task.state) {
                            continue;
                        }
                        if let Some(kind) = kind_for_state(&task.state) {
                            if kind_enabled(kind, settings) {
                                events.push(task_event(kind, task_id, task));
                            }
                        }
                    }
                }
            }
            self.known_states = Some(tasks.iter().map(|(id, task)| (id.clone(), task.state.clone())).collect());
        }

        if self.core_reachable == Some(true)
            && !current.core_reachable
            && !current.stopped_on_purpose()
            && kind_enabled(EventKind::CoreStoppedUnexpectedly, settings)
        {
            events.push(core_stopped_event());
        }
        self.core_reachable = Some(current.core_reachable);

        if settings.notifications_enabled {
            events
        } else {
            Vec::new()
        }
    }
}

/// The tray icon's tooltip.
pub fn tray_tooltip(snapshot: &Snapshot) -> String {
    if snapshot.core_reachable {
        format!("🛡️ JERRY · GUARDED · {} waiting", snapshot.waiting_count())
    } else if snapshot.stopped_on_purpose() {
        "🛡️ JERRY · Core stopped".to_owned()
    } else {
        "🛡️ JERRY · Core unreachable".to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(tasks: &[(&str, &str)]) -> Snapshot {
        Snapshot {
            tasks: Some(
                tasks
                    .iter()
                    .map(|(id, state)| ((*id).to_owned(), TaskEntry { state: (*state).to_owned(), title: format!("Title of {id}") }))
                    .collect(),
            ),
            core_reachable: true,
            stopped_by_user: false,
            autostart_disabled: false,
        }
    }

    fn unreachable() -> Snapshot {
        Snapshot { tasks: None, core_reachable: false, stopped_by_user: false, autostart_disabled: false }
    }

    fn kinds(events: &[Event]) -> Vec<EventKind> {
        events.iter().map(|event| event.kind).collect()
    }

    #[test]
    fn the_first_poll_is_a_baseline_with_at_most_one_summary() {
        let settings = Settings::default();
        let mut notifier = Notifier::new();
        let events = notifier.observe(
            &snapshot(&[("JRY-0001", WAIT_PLAN_APPROVAL), ("JRY-0002", WAIT_IMPLEMENTATION_ACCEPTANCE), ("JRY-0003", DONE), ("JRY-0004", BLOCKED)]),
            &settings,
        );
        assert_eq!(kinds(&events), vec![EventKind::WaitingSummary]);
        assert_eq!(events[0].title, "📋 2 decisions waiting in JERRY");
        assert_eq!(events[0].body, "JRY-0001 plan · JRY-0002 report");

        let mut quiet = Notifier::new();
        assert!(quiet.observe(&snapshot(&[("JRY-0003", DONE), ("JRY-0005", "IMPLEMENTATION")]), &settings).is_empty());
    }

    #[test]
    fn every_task_event_type_is_raised_with_its_emoji() {
        let settings = Settings::default();
        let mut notifier = Notifier::new();
        notifier.observe(&snapshot(&[("JRY-0001", "PLAN_DRAFT"), ("JRY-0002", "IMPLEMENTATION"), ("JRY-0003", "CODE_REVIEW"), ("JRY-0004", "FINAL_REPORT"), ("JRY-0005", "IMPLEMENTATION")]), &settings);
        let events = notifier.observe(
            &snapshot(&[
                ("JRY-0001", WAIT_PLAN_APPROVAL),
                ("JRY-0002", WAIT_IMPLEMENTATION_ACCEPTANCE),
                ("JRY-0003", WAIT_REVIEW_FIX_APPROVAL),
                ("JRY-0004", DONE),
                ("JRY-0005", BLOCKED),
            ]),
            &settings,
        );
        assert_eq!(
            kinds(&events),
            vec![EventKind::PlanWaiting, EventKind::ReportWaiting, EventKind::FixesWaiting, EventKind::TaskDone, EventKind::TaskBlocked]
        );
        let titles: Vec<&str> = events.iter().map(|event| event.title.as_str()).collect();
        for (title, emoji) in titles.iter().zip(["📋", "📄", "🛠️", "🏁", "⛔"]) {
            assert!(title.starts_with(emoji), "{title}");
        }
        assert_eq!(events[0].task_id.as_deref(), Some("JRY-0001"));
        assert_eq!(events[0].body, "JRY-0001 · Title of JRY-0001");
    }

    #[test]
    fn a_new_task_already_waiting_is_raised() {
        let settings = Settings::default();
        let mut notifier = Notifier::new();
        notifier.observe(&snapshot(&[]), &settings);
        assert_eq!(kinds(&notifier.observe(&snapshot(&[("JRY-0009", WAIT_PLAN_APPROVAL)]), &settings)), vec![EventKind::PlanWaiting]);
    }

    #[test]
    fn each_transition_is_told_once() {
        let settings = Settings::default();
        let mut notifier = Notifier::new();
        notifier.observe(&snapshot(&[("JRY-0001", "PLAN_DRAFT")]), &settings);
        assert_eq!(notifier.observe(&snapshot(&[("JRY-0001", WAIT_PLAN_APPROVAL)]), &settings).len(), 1);
        assert!(notifier.observe(&snapshot(&[("JRY-0001", WAIT_PLAN_APPROVAL)]), &settings).is_empty());
        // Core goes away and comes back: nothing is repeated.
        assert!(notifier.observe(&unreachable(), &settings).iter().all(|event| event.kind == EventKind::CoreStoppedUnexpectedly));
        assert!(notifier.observe(&snapshot(&[("JRY-0001", WAIT_PLAN_APPROVAL)]), &settings).is_empty());
        // A revised plan goes through the state again: a new transition, told again.
        notifier.observe(&snapshot(&[("JRY-0001", "PLAN_DRAFT")]), &settings);
        assert_eq!(kinds(&notifier.observe(&snapshot(&[("JRY-0001", WAIT_PLAN_APPROVAL)]), &settings)), vec![EventKind::PlanWaiting]);
    }

    #[test]
    fn core_stopping_unexpectedly_is_told_once() {
        let settings = Settings::default();
        let mut notifier = Notifier::new();
        notifier.observe(&snapshot(&[]), &settings);
        let events = notifier.observe(&unreachable(), &settings);
        assert_eq!(kinds(&events), vec![EventKind::CoreStoppedUnexpectedly]);
        assert!(events[0].title.starts_with("⚠️"));
        assert!(notifier.observe(&unreachable(), &settings).is_empty());
    }

    #[test]
    fn core_unreachable_from_the_start_is_not_a_stop() {
        let mut notifier = Notifier::new();
        assert!(notifier.observe(&unreachable(), &Settings::default()).is_empty());
    }

    #[test]
    fn no_core_stopped_event_after_a_user_stop_or_with_the_marker() {
        let settings = Settings::default();
        for (stopped_by_user, autostart_disabled) in [(true, false), (false, true), (true, true)] {
            let mut notifier = Notifier::new();
            notifier.observe(&snapshot(&[]), &settings);
            let stopped = Snapshot { stopped_by_user, autostart_disabled, ..unreachable() };
            assert!(notifier.observe(&stopped, &settings).is_empty());
        }
    }

    #[test]
    fn the_master_switch_silences_everything_but_keeps_the_memory() {
        let off = Settings { notifications_enabled: false, ..Settings::default() };
        let mut notifier = Notifier::new();
        assert!(notifier.observe(&snapshot(&[("JRY-0001", WAIT_PLAN_APPROVAL)]), &off).is_empty());
        assert!(notifier.observe(&snapshot(&[("JRY-0001", DONE)]), &off).is_empty());
        assert!(notifier.observe(&unreachable(), &off).is_empty());
        // Switched on again: what happened meanwhile is not replayed.
        assert!(notifier.observe(&snapshot(&[("JRY-0001", DONE)]), &Settings::default()).is_empty());
    }

    #[test]
    fn per_type_switches_filter_their_events_only() {
        let settings = Settings { plan_waiting: false, task_done: false, core_stopped: false, ..Settings::default() };
        let mut notifier = Notifier::new();
        let baseline = notifier.observe(&snapshot(&[("JRY-0001", WAIT_PLAN_APPROVAL), ("JRY-0002", "IMPLEMENTATION"), ("JRY-0003", "FINAL_REPORT")]), &settings);
        assert!(baseline.is_empty(), "a waiting plan is not summarised when plan notifications are off");
        let events = notifier.observe(&snapshot(&[("JRY-0001", "IMPLEMENTATION"), ("JRY-0002", WAIT_IMPLEMENTATION_ACCEPTANCE), ("JRY-0003", DONE)]), &settings);
        assert_eq!(kinds(&events), vec![EventKind::ReportWaiting]);
        assert!(notifier.observe(&unreachable(), &settings).is_empty());

        let none_waiting = Settings { plan_waiting: false, report_waiting: false, fixes_waiting: false, ..Settings::default() };
        let mut notifier = Notifier::new();
        assert!(notifier.observe(&snapshot(&[("JRY-0002", WAIT_IMPLEMENTATION_ACCEPTANCE)]), &none_waiting).is_empty());
    }

    #[test]
    fn a_long_summary_is_shortened() {
        let tasks: Vec<(String, &str)> = (1..=7).map(|n| (format!("JRY-{n:04}"), WAIT_REVIEW_FIX_APPROVAL)).collect();
        let tasks: Vec<(&str, &str)> = tasks.iter().map(|(id, state)| (id.as_str(), *state)).collect();
        let events = Notifier::new().observe(&snapshot(&tasks), &Settings::default());
        assert_eq!(events.len(), 1);
        assert!(events[0].body.ends_with("+2 more"), "{}", events[0].body);
        assert!(events[0].body.starts_with("JRY-0001 fixes"));
    }

    #[test]
    fn the_tooltip_says_what_core_is_doing() {
        let running = snapshot(&[("JRY-0001", WAIT_PLAN_APPROVAL), ("JRY-0002", WAIT_REVIEW_FIX_APPROVAL), ("JRY-0003", DONE)]);
        assert_eq!(tray_tooltip(&running), "🛡️ JERRY · GUARDED · 2 waiting");
        assert_eq!(tray_tooltip(&unreachable()), "🛡️ JERRY · Core unreachable");
        assert_eq!(tray_tooltip(&Snapshot { autostart_disabled: true, ..unreachable() }), "🛡️ JERRY · Core stopped");
        assert_eq!(tray_tooltip(&Snapshot { stopped_by_user: true, ..unreachable() }), "🛡️ JERRY · Core stopped");
    }
}
