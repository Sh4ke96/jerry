# JERRY plugin for Claude Code

JERRY is a local development guardian. This plugin connects Claude Code to the JERRY Core
process running on the same machine. Before every file edit (Write, Edit, NotebookEdit) and
every shell command (Bash, PowerShell, Monitor), the plugin asks JERRY Core whether the
operation is covered by a plan that the user has approved. Edits inside Git repositories
without an approved plan are blocked. When JERRY Core is not running, edits are blocked as
well (fail-closed), while read-only shell commands continue to work.

The plugin stores nothing in your projects. All JERRY data lives in `%LOCALAPPDATA%\JERRY`
(or `JERRY_HOME`). Install, update and remove it with the `jerry` CLI (`jerry install`,
`jerry uninstall`, `jerry doctor`), never by editing files by hand.
