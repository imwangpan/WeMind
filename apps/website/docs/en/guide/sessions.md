---
description: Create, resume, rename, and delete WeMind sessions.
---

# Sessions

WeMind stores one pointer: which session WeChat is currently using. The actual conversation history belongs to the agent.

## List

```bash
wemind session list
```

In WeChat:

```text
会话列表
/sessions
```

## New

```bash
wemind session new weekly-report
```

In WeChat:

```text
新会话 weekly-report
/new weekly-report
```

## Resume

```bash
wemind session resume 3
wemind session resume weekly-report
```

In WeChat:

```text
恢复会话 3
/resume 3
```

Resume is strict: if the agent cannot load or resume the session, WeMind reports the error. It does not silently create a new session or change the current pointer.

## Rename and delete

```bash
wemind session rename 3 new-name
wemind session delete 3
```

In WeChat:

```text
重命名会话 3 new-name
删除会话 3
```

## Ownership

- Sessions are isolated per account.
- WeChat session commands only affect the logged-in owner's sessions.
- Switching the brain does not delete old sessions. Each agent has its own session list.
- `brain-sessions.json` is the source of truth for the current session. `session-registry.json` is derived metadata; a write failure is logged but does not fail the turn.

## Working directory

When resuming, WeMind prefers the directory recorded in `session-cwd.json`. If it no longer exists, is a UNC path, or is not a directory, WeMind logs a warning and falls back to the default workspace.

```bash
wemind workspace show
wemind workspace set /path/to/project
```

## Troubleshooting

**Resume looks like a new session.** Check `wemind log --errors`. The agent may not support `session/load` or `session/resume`; WeMind will report that rather than pretend success.

**The list differs from the agent's history.** WeMind's list is its own registry, not the agent's full history. Trust the current pointer in `brain-sessions.json`.
