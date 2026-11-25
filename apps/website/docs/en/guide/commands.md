---
description: Common WeMind CLI commands for accounts, agents, sessions, tasks, and configuration.
---

# Commands

The package is `@wemind/cli`; the command is `wemind`. They are not the same name.

```bash
wemind help
wemind <command> --help
```

## Accounts and processes

| Command | Purpose |
| --- | --- |
| `wemind login --label work --start` | Scan and start an account |
| `wemind list` | List accounts and status |
| `wemind start [key\|label]` / `stop` | Start or stop an account |
| `wemind log [key\|label] [--errors]` | Read the daemon log |
| `wemind label <key> <name>` | Rename a label |
| `wemind set-default <key\|label>` | Set the default account |
| `wemind logout` / `delete` | Log out / delete account data |
| `wemind allowlist` / `allow` / `revoke` | Manage the owner allowlist |

## Brain and agents

| Command | Purpose |
| --- | --- |
| `wemind brain` | Show the current brain |
| `wemind brain check` | Real ACP handshake |
| `wemind brain set <agent>` | Persist a new brain |
| `wemind brain switch <agent>` | Switch the running daemon |
| `wemind brain handoff` | Generate a handoff summary |
| `wemind agent list` / `show` | Inspect agent definitions |
| `wemind agent check <agent>` | Validate and handshake |
| `wemind agent add` / `remove` | Install or remove local definitions |

Use `--extra-args` to append startup arguments. `--args` replaces the whole argument list and can drop the ACP mode flag.

## Sessions

```bash
wemind session list
wemind session new [name]
wemind session resume <index|name|id>
wemind session rename <index|name> <new-name>
wemind session delete <index>
```

## Tasks

```bash
wemind task "do something" --cwd /path/to/project --agent codex
wemind task-list
wemind task-status [id]
wemind task-reply [id] "continue"
wemind task-stop [id|all]
wemind task-resume-all
```

## Configuration and MCP

```bash
wemind config show
wemind config home-mode [direct|managed]
wemind config reload
wemind mcp list|enable|disable|add|remove
wemind workspace show|set|reset
wemind env capture|show|clear
```

`wemind mcp` manages the `managed` activation set only. In `direct` mode, edit the agent's own MCP configuration.

## Autostart and version

```bash
wemind autostart install|status|uninstall
wemind version
```

## Logs

```bash
wemind log --errors
wemind log --lines 200
```

The log command prints a snapshot, not a follow stream. Use `tail -f` or `pm2 logs wemind-<key>` for live output.
