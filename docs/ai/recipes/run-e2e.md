# 配方：端到端验收

> **适用版本**：WeMind 1.0.1 ｜ **最后核对**：2026-10-24
>
> 目标：用最短路径证明「微信 → daemon → ACP 大脑 → 微信」真的通，而不是只看编译通过。
> 前置：已构建、已登录一个 bot、`allowFrom` 包含你的微信、至少一个 ACP agent 可用。

---

## 0. 分层验收（从便宜到贵）

| 层 | 命令 | 证明什么 |
|---|---|---|
| L1 编译/单测 | `npm run build && npm run typecheck && npm test` | 代码不崩 |
| L2 大脑可用 | `node .../cli.js brain check <key>` | 二进制存在 + 能说 ACP（initialize/session-new） |
| L3 ACP 冒烟 | `node scripts/acp-probe.mjs`（env 指定 agent） | prompt / update / load|resume / 反向请求 |
| L4 微信单轮 | 发一条消息，看 `prompt ok` + 收到回复 | iLink + daemon + brain 全链路 |
| L5 多轮/自愈 | 杀 daemon → 再起 → 追问上一轮 | session 恢复 |
| L6 任务/图片/MCP | 按需 | 专项能力 |

> 没有 L4 的证据，不要写「已端到端验证」。

DSH 的 L3 示例（隔离凭据；不要把真实 `~/.dsh` 交给探针）：

```powershell
$env:ACP_BIN = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"  # 按实际安装位置调整
$env:ACP_ARGS = '["--profile","acp"]'
$env:ACP_SHELL = "1"
$env:ACP_HOME_ENV = "DSH_HOME"
$env:ACP_HOME = "$env:TEMP\dsh-probe"
$env:ACP_MODEL = '["deepseek-account","deepseek-flash"]'   # 桌面登录必须选 account
# 可选：把 ~/.dsh/.credentials.yaml 复制到 ACP_HOME（敏感文件，测完删除）
node scripts/acp-probe.mjs
```

---

## 1. 准备

```powershell
# 1) 构建
npm run build
npm run typecheck
npm test

# 2) 环境事实
pwsh -NoProfile -File scripts/doctor.ps1

# 3) 账号
wemind list
```

> 下文的 `wemind` 指已发布的 CLI（`npm i -g @wemind/cli`，安装后用 `wemind version` 验证）。
> 在仓库里跑源码版时等价于 `node packages/wechat-daemon/dist/cli.js <子命令>`；两种方式操作同一份 `~/.wemind/` 数据。

如果还没有账号：

```powershell
wemind login --label 我的bot --start
```

> 登录会出二维码，需要你本人扫码；这一步无法由 CI 代跑。

---

## 2. 选大脑 & 自检

```powershell
wemind brain <key>
wemind brain check <key>
```

期望：`可用：✅ ...`，且 `brain check` 打印 `ACP 握手成功（initialize + session/new）`。

如果失败：先看 [`debug-daemon.md`](debug-daemon.md) §3.1，不要直接改代码。

---

## 3. 启动

```powershell
wemind start <key>
wemind list
```

期望：`运行中(pid ...) brain(pid ...)`（brain 是懒启动，第一条消息后才有 pid）。

---

## 4. 微信单轮（L4）

1. 用**已授权**的微信给 bot 发：`你好，只回复 OK`；
2. 看日志：

```powershell
Get-Content "$env:USERPROFILE\.wemind\<key>\daemon.log" -Tail 80
```

期望顺序：

```text
[wemind/wechat-daemon] turn start to=...
[wemind/wechat-daemon/acp] spawn ... 
[wemind/wechat-daemon/acp] initialized
[wemind/wechat-daemon/acp] session/new ok ...   # 首次
[wemind/wechat-daemon/acp] → session/prompt#...
[wemind/wechat-daemon/acp] prompt ok ... chunks=N updateTypes=[...]
[wemind/wechat-daemon] replied to ...
```

3. 微信收到回复。

---

## 5. 多轮 / 自愈（L5）

1. 发「记住暗号 PINEAPPLE，只回复收到」；
2. 杀掉 daemon（`wemind stop <key>`），再 `start`；
3. 发「暗号是什么？只回复暗号」；
4. 期望：回复包含 `PINEAPPLE`，日志出现 `session/load ok` 或 `session/resume ok`。

> 如果出现 `session/load failed ... creating new`，且 agent 支持 resume，说明 M2 的 resume 兜底还没做；记录为缺陷，不要当成「模型记性差」。

---

## 6. 任务 / 图片 / MCP（L6）

### worker

```powershell
wemind task "在任务目录创建一个 hello.txt，内容为 hello"
wemind task-status <key>
wemind task-reply "继续" <key>
```

微信端也可发 `任务：xxx` / `继续`。期望：`task-status` 有输出，任务目录出现文件。

### 图片

- 发一张图 → 支持 image 的 agent 应能描述；不支持（如 DSH 官方）应被友好拦截，而不是反复 `-32602` 重试。
- 看 `promptCapabilities.image`：`wemind brain check` 不打印能力，跑 `scripts/acp-probe.mjs` 看 `initialize`。

### MCP

```text
MCP
加载 <名>
<发一条需要该工具的消息>
卸载 <名>
```

期望：下一条消息生效；`wechat` 被拒绝。

---

## 7. 验收清单

| # | 项 | 通过标准 |
|---|---|---|
| 1 | 构建/单测 | 全绿 |
| 2 | `brain check` | `initialize + session/new` 成功 |
| 3 | 单轮 | 日志 `prompt ok`，微信收到非空回复 |
| 4 | 多轮 | 重启后追问，上下文还在（load/resume） |
| 5 | 新会话 | `新会话` 后旧上下文清空 |
| 6 | 自愈 | 杀进程后下一条能重建并恢复 |
| 7 | 长任务 | 不因首帧误杀；进度不刷屏 |
| 8 | 反向请求 | 有则应答，不卡死 |
| 9 | 图片 | 按 agent 能力工作或友好拒绝 |
| 10 | MCP | 加载/卸载生效；`wechat` 禁止 |
| 11 | worker | 派发/中断/继续可用 |
| 12 | 多账号 | 沙箱/会话隔离 |

---

## 8. 清理 / 回滚

```powershell
wemind stop <key>
# 清空 DeepSeek/某 agent 的对话记忆：
#   删 <数据目录>/brain-sessions.json + brain-home/sessions/
# 回退大脑：
wemind brain set kiro --restart <key>
```

不要删 `account.json`，除非你要重新扫码登录。

---

## 9. 参考

- [`docs/新手教程.md`](../../新手教程.md)
- [`docs/repowiki/05-守护进程-Daemon.md`](../../repowiki/05-守护进程-Daemon.md)
- [`docs/ai/recipes/debug-daemon.md`](debug-daemon.md)
- [`scripts/acp-probe.mjs`](../../../scripts/acp-probe.mjs)
