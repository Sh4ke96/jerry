// Settings page, shown in the main window (no separate window). Every change is saved at once
// through set_settings, which also applies "Launch with Windows" and reports what Windows really
// has. "Back to the dashboard" returns to the dashboard's Settings when the page was opened from
// there, else to the dashboard's root.
const { invoke } = window.__TAURI__.core;
const FROM_DASHBOARD = new URLSearchParams(window.location.search).get('from') === 'dashboard';

const $ = (id) => document.getElementById(id);
const FIELDS = [
  'launchWithWindows',
  'openWindowOnStart',
  'notificationsEnabled',
  'planWaiting',
  'reportWaiting',
  'fixesWaiting',
  'taskDone',
  'taskBlocked',
  'coreStopped',
];
let settings = null;
let saving = false;

function setMessage(text, isError = false) {
  $('message').textContent = text;
  $('message').classList.toggle('message--error', isError);
}

function render() {
  for (const field of FIELDS) {
    $(field).setAttribute('aria-checked', String(Boolean(settings[field])));
  }
  $('sound').value = settings.sound;
  // The per-type switches and the sound only matter while notifications are on.
  for (const row of document.querySelectorAll('[data-type]')) {
    const off = !settings.notificationsEnabled;
    row.classList.toggle('option--disabled', off);
    row.querySelector('.switch, .select').disabled = off;
  }
  $('test').disabled = false;
}

async function save(next) {
  if (saving) return;
  saving = true;
  try {
    settings = await invoke('set_settings', { settings: next });
    setMessage('Saved.');
  } catch (error) {
    setMessage(String(error), true);
    try {
      settings = await invoke('get_settings');
    } catch {
      // keep what is shown
    }
  } finally {
    saving = false;
    render();
  }
}

for (const field of FIELDS) {
  $(field).addEventListener('click', () => {
    if (settings === null) return;
    save({ ...settings, [field]: !settings[field] });
  });
}

$('sound').addEventListener('change', () => {
  if (settings === null) return;
  save({ ...settings, sound: $('sound').value });
});

$('test').addEventListener('click', async () => {
  try {
    // The sound shown in the list, so the test plays it even while the change is being saved.
    await invoke('send_test_notification', { sound: $('sound').value });
    setMessage('Test notification sent.');
  } catch (error) {
    setMessage(String(error), true);
  }
});

$('back').addEventListener('click', async () => {
  $('back').disabled = true;
  setMessage('Opening the dashboard…');
  try {
    await invoke('retry', { route: FROM_DASHBOARD ? '#/settings' : null });
  } catch (error) {
    // Core is not reachable: the fallback page says why.
    setMessage(String(error), true);
  } finally {
    $('back').disabled = false;
  }
});

async function refreshCore() {
  try {
    const info = await invoke('core_info');
    $('core-status').textContent = info.reason && info.state !== 'running' ? `${info.statusText} · ${info.reason}` : info.statusText;
    $('core-version').textContent = info.version ?? '—';
    $('app-version').textContent = info.appVersion;
    $('core-home').textContent = info.jerryHome;
  } catch (error) {
    setMessage(String(error), true);
  }
}

async function load() {
  try {
    settings = await invoke('get_settings');
    render();
  } catch (error) {
    setMessage(String(error), true);
  }
  await refreshCore();
}

load();
setInterval(refreshCore, 5000);
