---
description: Give long-running work to a controlled agent and reply from WeChat.
---

# Tasks

The chat brain handles conversation. Tasks handle long-running work in a separate controlled agent process.

## Create

```bash
wemind task "summarize the integration docs into one page" --cwd /path/to/project
wemind task --agent codex "run the tests and summarize failures"
```

In WeChat:

```text
任务：summarize the integration docs into one page
任务 codex：run the tests and summarize failures
```

## Check status

```bash
wemind task-list
wemind task-status
wemind task-status 2
```

In WeChat:

```text
任务列表
/tasks
```

## Reply

When a task needs a decision, it pushes a message to WeChat. Reply with the task number:

```bash
wemind task-reply 2 "choose option B and continue"
```

In WeChat:

```text
#2 choose option B and continue
/reply 2 choose option B and continue
```

Messages without `#<id>` go to the chat brain by default.

To send several messages or attachments to one task, set it as the recipient first:

```text
发给任务 2
#2
```

Then send text or attachments. Send `好了` / `就这样` to submit, or wait three minutes for automatic submission.

## Stop

```bash
wemind task-stop 2
wemind task-stop all
```

In WeChat:

```text
结束任务 2
结束全部任务
```

- A task waiting for your reply keeps its process for reuse.
- A running task cannot be cancelled gracefully over ACP; WeMind kills it.
- When multiple tasks exist, include the task number.

## Workers and restarts

- Default maximum: three workers; idle workers are reclaimed after five minutes.
- Each task has its own ACP connection. Different agents can run different tasks.
- After a daemon restart, unfinished tasks are marked as interrupted. They do not restart automatically. Reply "continue" or run `wemind task-resume-all`.

## Attachments

Set a recipient, send attachments, then send a text message:

```text
发给任务 2
[image]
[file]
apply this and tell me when done
```

Attachments are buffered briefly so images sent in a burst join the same turn. Without a recipient, messages with attachments go to the chat brain.

## When to use tasks

| Scenario | Use |
| --- | --- |
| Quick question or edit | Chat brain |
| Test suite, whole-repo read, batch edits | Task |
| Needs your decision mid-way | Task |
| Independent parallel work | Multiple tasks / agents |
