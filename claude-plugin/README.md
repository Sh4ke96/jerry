# JERRY plugin for Claude Code

JERRY is a local development guardian. This plugin connects Claude Code to the JERRY Core
process running on the same machine. Before every file edit (Write, Edit, NotebookEdit) and
every shell command (Bash, PowerShell, Monitor), the plugin asks JERRY Core how the operation
relates to the plan the user approved.

JERRY monitors; it does not stop Claude's work. An edit without an approved plan, or outside
its scope, proceeds, is recorded as a deviation, and both Claude and the user are warned.
JERRY blocks only its hard rules: any Git command that changes repository state (the user runs
all Git operations), writes inside `.git`, and attempts to modify JERRY data or the Claude Code
settings that keep JERRY enabled. Agents may not read JERRY's own data either (its run, config,
state, database, backups, spool and logs folders; the plugin files stay readable), nor run the
user-only `jerry` commands. The hard rules are checked locally, so they hold even when JERRY Core
is not running.

The plugin stores nothing in your projects and JERRY never modifies a repository. All JERRY
data lives in `%LOCALAPPDATA%\JERRY` (or `JERRY_HOME`). Install, update and remove it with the
`jerry` CLI (`jerry install`, `jerry uninstall`, `jerry doctor`).
