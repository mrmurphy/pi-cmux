# pi-cmux

A pi package that adds direct `cmux` integration to pi:

- Tool: `cmux_cli`
- Tool: `cmux_notify`
- Slash command: `/cmux`
- Slash command: `/cmux-notify`
- Agent lifecycle status/log/notification integration

---

## Install

### With pi (local path)

```bash
pi install ./
```

### With pi (directly from this git repo)

```bash
# shorthand
pi install git:github.com/simonjohansson/pi-cmux

# pin to a ref/tag/branch
pi install git:github.com/simonjohansson/pi-cmux@v0.1.0

# raw URL also works
pi install https://github.com/simonjohansson/pi-cmux
```

---

## Package layout

- `extensions/cmux/index.ts` — extension entrypoint
- Loaded via this package manifest (`package.json` → `pi.extensions`)

---

## What this extension adds

### Tools (for the LLM)

1. **`cmux_cli`**
   - Runs any cmux command by passing `argv` (without leading `cmux`).
   - Example: `argv: ["list-workspaces", "--json"]`

2. **`cmux_notify`**
   - Convenience wrapper for `cmux notify --title ... --body ... [--subtitle ...]`.

### Slash commands (for you)

1. **`/cmux <args>`**
   - Runs cmux CLI directly from pi command mode.
   - Example: `/cmux list-workspaces --json`
   - Example: `/cmux browser open https://example.com`

2. **`/cmux-notify <title> | <body> | [subtitle]`**
   - Sends cmux notifications quickly.
   - Example: `/cmux-notify Build Complete | All tests passed | CI`

### Lifecycle integration

During pi runs, the extension can push status/log/notifications to cmux:

- On `agent_start`: `set-status` (default key: `pi`)
- On each tool execution: `log` start/end in sidebar log
- On `agent_end`: clears status + sends "Session complete" notification
- On shutdown: clears status

---

## How cmux CLI targeting works

Based on `cmux help`:

### General usage

```bash
cmux [--socket PATH] [--window WINDOW] [--password PASSWORD] [--json] [--id-format refs|uuids|both] <command> [options]
```

### ID inputs

Most commands accept any of:

- UUIDs
- Short refs (`window:1`, `workspace:2`, `pane:3`, `surface:4`)
- Indexes

Special case:

- `tab-action` also accepts `tab:<n>`

Output ID format defaults to refs. Use:

- `--id-format uuids`
- `--id-format both`

### Socket auth precedence

1. `--password`
2. `CMUX_SOCKET_PASSWORD`
3. Keychain password saved in cmux Settings

---

## Command families you can control through this extension

All of these are available via `cmux_cli` and `/cmux`:

1. **System / discovery**
   - `ping`, `capabilities`, `identify`, `help`, `version`

2. **Window management**
   - `list-windows`, `new-window`, `focus-window`, `close-window`, `rename-window`

3. **Workspace management**
   - `list-workspaces`, `new-workspace`, `current-workspace`, `select-workspace`, `close-workspace`, `rename-workspace`, `reorder-workspace`, `move-workspace-to-window`, `workspace-action`

4. **Pane / surface / panel management**
   - `new-split`, `new-pane`, `new-surface`, `close-surface`, `move-surface`, `reorder-surface`, `focus-pane`, `list-panes`, `list-pane-surfaces`, `list-panels`, `focus-panel`, `drag-surface-to-split`, `tab-action`, `rename-tab`

5. **Terminal I/O**
   - `read-screen`, `send`, `send-key`, `send-panel`, `send-key-panel`, `capture-pane`, `clear-history`

6. **Notifications**
   - `notify`, `list-notifications`, `clear-notifications`, `claude-hook`

7. **Sidebar metadata**
   - `set-status`, `clear-status`, `list-status`
   - `set-progress`, `clear-progress`
   - `log`, `clear-log`, `list-log`
   - `sidebar-state`

8. **Browser automation**
   - `browser ...` with `open`, `navigate`, `snapshot`, `eval`, `wait`, DOM actions (`click`, `fill`, `press`, etc.), `cookies`, `storage`, `tab`, `console`, `errors`, `state`, `frame`, `dialog`, `download`, and more

9. **tmux-compat commands**
   - `resize-pane`, `swap-pane`, `join-pane`, `break-pane`, `wait-for`, `pipe-pane`, `set-hook`, buffers, etc.

---

## Environment defaults (cmux)

cmux automatically uses these when available:

- `CMUX_WORKSPACE_ID` — default workspace target
- `CMUX_SURFACE_ID` — default surface target
- `CMUX_TAB_ID` — optional alias for tab commands
- `CMUX_SOCKET_PATH` — custom socket path

So commands like `send`, `new-split`, `notify`, etc. can often omit explicit `--workspace`/`--surface` inside cmux terminals.

---

## Examples

### Slash command examples

```bash
/cmux ping
/cmux list-workspaces --json --id-format both
/cmux new-split right
/cmux send "npm test\n"
/cmux browser open https://example.com
/cmux browser surface:2 snapshot --interactive --compact
/cmux-notify Build Complete | All tests passed | CI
```

### LLM tool examples

- `cmux_cli` with `argv: ["list-workspaces", "--json"]`
- `cmux_cli` with `argv: ["set-progress", "0.5", "--label", "Building..."]`
- `cmux_cli` with `argv: ["browser", "surface:2", "click", "button[type='submit']"]`
- `cmux_notify` with `title/body/subtitle`

---

## Extension-specific environment variables

- `CMUX_CLI_PATH` (default: `cmux`)
- `PI_CMUX_STATUS_KEY` (default: `pi`)
- `PI_CMUX_ENABLE_NOTIFICATIONS` (`true`/`false`, default: `true`)
- `PI_CMUX_ENABLE_STATUS` (`true`/`false`, default: `true`)
- `PI_CMUX_NOTIFY_TOOL_NAMES` (CSV, default: `task,subagent`)

---

## Development

In pi:

```bash
/reload
```

Or restart pi.
