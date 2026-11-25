---
description: What it takes to connect an AI agent to WeMind over ACP.
---

# Connect an Agent

WeMind does not implement its own AI. It connects WeChat to an agent already running on your machine.

## Four requirements

1. **An executable entry point** that can be started on your machine.
2. **ACP over stdio**, either native or through an adapter.
3. **The minimal method set**: initialize, create/resume a session, send a prompt, stream updates.
4. **Its own authentication** works without a human sitting in a terminal.

An HTTP-only model API (OpenAI, Anthropic, Ollama) cannot be connected directly today.

## Check an agent

```bash
wemind agent list
wemind agent show codex --explain
wemind agent check codex
wemind brain check
```

- `agent check` performs a real ACP handshake by default.
- `--schema` only validates the definition.
- `--deep` also sends a real prompt.

## Custom definitions

A local definition lives at `~/.wemind/.agents/<name>.json`:

```json
{
  "schemaVersion": 1,
  "name": "my-agent",
  "bin": "my-agent",
  "args": ["acp"],
  "shell": false,
  "acpMcpServers": false,
  "mcpDelivery": "config",
  "notes": ["Local custom agent"]
}
```

Validate and install:

```bash
wemind agent check ~/.wemind/.agents/my-agent.json
wemind agent add ~/.wemind/.agents/my-agent.json
```

A local definition with the same name replaces the built-in one. A broken definition fails closed; it does not silently fall back.

## Adapters

If the agent has a CLI but does not speak ACP, provide an adapter module:

```json
{
  "adapter": {
    "module": "my-adapter",
    "apiVersion": 1
  }
}
```

Adapters can add file formats and prepare the spawn. They cannot replace session resume, turn framing, idle waits, permission replies, or reverse requests.

## Common failures

- **Handshake timeout**: the `args` do not put the agent into ACP mode.
- **Handshake works, no reply**: check `wemind log --errors`; the agent may lack activity frames or need model configuration.
- **Windows ENOENT**: `.cmd` files need `binWin` and `shell: true`.
