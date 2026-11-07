// Fallback page of the main window: shown while JERRY Core cannot be reached.
// It only calls Jerry's own commands; it never sees the Core token.
const { invoke } = window.__TAURI__.core;

const $ = (id) => document.getElementById(id);
let busy = false;

function setMessage(text, isError = false) {
  $('message').textContent = text;
  $('message').classList.toggle('message--error', isError);
}

function render(info) {
  const stopped = info.state === 'stopped';
  const running = info.state === 'running';
  $('title').textContent = running
    ? '🛡️ JERRY Core is running'
    : stopped
      ? '⏸️ JERRY Core is stopped'
      : '⚠️ JERRY Core is not reachable';
  $('description').textContent = running
    ? 'Choose Retry to open the dashboard.'
    : stopped
      ? 'Core was stopped on purpose. Claude Code sessions will not start it until you choose Start Core.'
      : 'The dashboard needs JERRY Core. Start it here, or retry once it runs.';
  $('badge-text').textContent = info.statusText;
  $('dot').className = `dot dot--${info.state}`;
  $('reason').textContent = info.reason ?? '';
  $('reason-box').hidden = running || !info.reason;
  $('home').textContent = info.jerryHome;
  $('app-version').textContent = info.version ? `${info.appVersion} · Core ${info.version}` : info.appVersion;
  $('start').disabled = busy || running;
}

async function refresh() {
  try {
    render(await invoke('core_info'));
  } catch (error) {
    setMessage(String(error), true);
  }
}

async function run(button, command, pending) {
  if (busy) return;
  busy = true;
  $('start').disabled = true;
  $('retry').disabled = true;
  setMessage(pending);
  try {
    const result = await invoke(command);
    setMessage(typeof result === 'string' ? `${result} Opening the dashboard…` : 'Opening the dashboard…');
  } catch (error) {
    setMessage(String(error), true);
  } finally {
    busy = false;
    $('retry').disabled = false;
    await refresh();
    button.focus();
  }
}

$('start').addEventListener('click', () => run($('start'), 'start_core', 'Starting JERRY Core…'));
$('retry').addEventListener('click', () => run($('retry'), 'retry', 'Connecting…'));

refresh();
setInterval(refresh, 5000);
