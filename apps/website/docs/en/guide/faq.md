---
description: "Common WeMind problems: QR login, connection, Node, Windows, tasks, and attachments."
---

# FAQ

## QR login does not complete

- The QR code expires quickly; refresh it.
- Try switching your phone between Wi-Fi and mobile data.
- Check `wemind log --errors` for iLink errors.

An iLink timeout often uses error code `-14` and pauses for about an hour. Restart the daemon or scan again.

## `wemind: command not found`

The package is `@wemind/cli`; the command is `wemind`.

```bash
npm i -g @wemind/cli
wemind version
```

For a one-off run, use `npx -y @wemind/cli`, not `npx wemind`.

## Wrong Node version

WeMind requires **Node.js 24.11+**. Check `node -v`. If you use nvm/fnm, make sure the daemon starts with the same Node version.

## WeChat replies sometimes, then stops

The most common cause is running both the MCP server and the daemon. One bot token can only be polled by one program.

```bash
wemind list
wemind stop
```

## The agent does not reply

1. `wemind list`: is the daemon running?
2. `wemind log --errors`: any ACP, model, or permission error?
3. `wemind brain check`: can the current agent handshake?
4. Are you the logged-in owner? Other users are blocked by the allowlist.
5. Is the MCP route also running?

## `brain check` times out

- The agent is not installed or not on PATH: `wemind agent show <agent> --explain`.
- The ACP mode flag is missing. Use `--extra-args`; `--args` replaces the whole list.
- The agent needs its own login first.
- Copilot is not auto-detected; select it explicitly.

## Windows credential or permission issues

- `account.json` is plaintext on Windows. Protect the disk and account.
- `.cmd` / `.bat` must run through a shell. Built-in definitions handle this; custom definitions need `binWin` and `shell: true`.
- Do not resolve bare command names from the task working directory.

## A task is stuck running

ACP turns cannot be cancelled gracefully. WeMind kills the process.

```bash
wemind task-list
wemind task-status <id>
wemind task-stop <id>
```

After a daemon restart, unfinished tasks are marked interrupted. They do not restart automatically; reply "continue" or run `wemind task-resume-all`.

## A task does not receive attachments

Set the recipient first:

```text
发给任务 2
```

Then send the image/file, followed by a text message. Without a recipient, attachments go to the chat brain.

## Attachments are not sent

- Use an absolute path.
- UNC/network paths are rejected.
- Sensitive files are blocked by default. Use `允许敏感文件` to open a temporary window.
- The default size limit is 25 MB.

## Can I run it on a cloud server?

Yes, but WeMind is designed for an agent on a machine you control. A cloud server becomes that machine; you are still responsible for login, permissions, keys, and disk security.

## Does WeMind upload chat history?

WeMind itself does not add a cloud relay. Messages are received by the local daemon and passed to the local agent. Whether the agent calls a cloud model depends on the agent and its configuration.

## Uninstall

```bash
wemind autostart uninstall
wemind stop
wemind delete
npm uninstall -g @wemind/cli
```

Then remove `~/.wemind` if you no longer need sessions or attachments.
