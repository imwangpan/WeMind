---
description: Choose, switch, and verify the agent that handles WeChat.
---

# Agents and Brain Switching

The "brain" is the agent currently handling WeChat. You can switch it without changing your WeChat entry point.

## Inspect

```bash
wemind brain
wemind agent list
```

In WeChat:

```text
AI
AI 列表
```

## Built-in presets

WeMind ships ten presets: OpenCode, Cline, Qoder, Gemini, DeepSeek Harness, Kiro, Copilot, Claude Code, Codex, and Pi.

- OpenCode, Cline, Qoder, Gemini, DeepSeek, and Kiro use native ACP and participate in auto-detection.
- Copilot uses native ACP but must be selected explicitly.
- Claude Code, Codex, and Pi use adapters and must be selected explicitly.

A preset only means WeMind knows how to launch it. It does not mean the agent is installed or logged in.

## Switch

Persist for future restarts:

```bash
wemind brain set codex
```

Switch the running daemon immediately:

```bash
wemind brain switch codex
```

In WeChat (owner only):

```text
切换大脑 codex
/brain codex
```

`switch` does not restart the daemon or interrupt an active turn. If it fails, WeMind keeps the previous brain.

## Verify

```bash
wemind brain check
wemind agent check codex
```

`brain check` starts the agent, performs a real ACP handshake, then cleans up. `agent check --schema` validates the definition without starting a process; `--deep` also sends a real prompt.

## Task brain

The chat brain and task brain can be different:

```bash
wemind brain set codex
wemind brain set opencode --worker
```

In WeChat:

```text
切换任务大脑 opencode
/task opencode
```

The task brain selection is runtime-only and is not written to `brain.json`.

## direct vs managed

| Mode | Behavior |
| --- | --- |
| `direct` (default) | Use the agent's real configuration; WeMind does not write it automatically |
| `managed` | WeMind maintains an account-scoped `brain-home` / `worker-home` and MCP activation set |

```bash
wemind config home-mode
wemind config home-mode managed
```

In `direct` mode, edit the agent's own MCP configuration. Only `managed` mode lets WeMind manage the MCP set.

## Troubleshooting

- **Switch fails**: check `wemind log --errors`; the agent may be missing, logged out, or missing its ACP mode flag.
- **No effect**: make sure the daemon is running; `switch` only affects a running daemon.
- **`brain check` hangs**: run `wemind agent check <agent> --schema` first, then check whether the agent needs an interactive login.
