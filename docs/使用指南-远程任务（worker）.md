# 使用指南：远程任务（worker）

> **适用版本**：WeMind 1.0.1 ｜ **最后核对**：2026-10-24
>
> 让一个**漫长任务在后台受控运行**，在它「需要你决策」（列了方案让你选）或「中断」时通知你，你回一句它就接着干。
> 两个入口管同一个任务：**微信**（人离开电脑时）＋ **本地终端**（人在电脑前时）。
> 背后原理见 [方案C-MVP-远程human-in-the-loop.md](方案C-MVP-远程human-in-the-loop.md)、[本地双入口-命令派发与看敲.md](本地双入口-命令派发与看敲.md)。

---

## 0. 前提

> `wemind` 是发布后的命令（`npm i -g wemind`，或 `npx wemind …`）；仍从源码跑时，把下文所有 `wemind` 替换为 `node packages/wechat-daemon/dist/cli.js`（如 `node packages/wechat-daemon/dist/cli.js list`）。

- daemon 正在运行（且已扫码登录某账号）。检查：
  ```bash
  wemind list   # 看到「运行中(pid …)」即可
  ```
- 没在跑就启动：`wemind start <key|label>`（或 `scripts/run-all-daemons.ps1` 全部账号）。

---

## 1. 一分钟上手

### 在电脑前（本地终端）

```bash
# 派发任务：在哪个项目目录就让它在哪跑（--cwd 默认取当前终端目录）
wemind task "核实这篇文章每个论断的真假，先列出你打算查证的点让我确认" --cwd D:\Product\xxx

# 看进展（状态 + 轮次 + 最近输出，不依赖微信）
wemind task-status

# 回复它的提问 / 让它继续 / 结束
wemind task-reply "第 2 点不用查，其它都查"
wemind task-reply 继续
wemind task-stop
```

### 在微信

```
任务：核实这篇文章每个论断的真假，先列出你打算查证的点让我确认
（它停下来问你时）直接回： 第 2 点不用查，其它都查      ← 它在等你，无前缀即注入
问大脑 现在几点                                        ← worker 跑着时想顺便问大脑别的
结束任务
```

---

## 2. 两个入口对照

| 操作 | 微信 | 本地终端（`wemind`） |
|---|---|---|
| **派发** | `任务：<描述>` 或 `>「描述」` | `task "<描述>" [--cwd 目录] [<key\|label>]` |
| **回复 / 续跑** | worker 等你时**直接回**；或回 `继续` | `task-reply "<内容>"` / `task-reply 继续` |
| **看状态** | 看 worker 推来的 `🤖【任务】…` 消息 | `task-status` |
| **结束** | `结束任务` / `停止任务` | `task-stop` |
| **临时问大脑** | `问大脑 <内容>`（worker 等你时也能插话） | 大脑对话不走这里——直接开你自己的 kiro，或用微信 |

> **核心**：两个入口操作的是**同一个任务**。可以本地派发、离开后用微信接着管；也可以微信派发、回到电脑用 `task-status` 看。

---

## 3. 典型场景

- **A. 电脑前开 + 离开遥控（最常用）**：终端 `task "..." --cwd 项目目录` 派发（长描述、指定项目都方便）→ `task-status` 看头几步对不对 → 放心离开 → 之后 worker 卡点会推微信，你在微信回一句续跑。
- **B. 纯本地**：不想碰微信、专注电脑工作，全程终端 `task` / `task-status` / `task-reply` / `task-stop`。
- **C. 纯微信远程**：人不在电脑，全程微信 `任务：` → 回复 → `结束任务`。

---

## 4. worker 能干什么

- 跑在你指定的工作目录（`--cwd`），**继承你 `~/.kiro` 的全部 MCP（除 `wechat`）＋ 记忆 / 技能 / 模型**——能力与你本地的 kiro 一致：读写文件、联网、调用工具都行。
- 适合**漫长任务**（联网核实、批量分析、构建、长文处理等）：后台跑、卡点找你，不占用你的电脑或当前会话。
- 每轮输出带 `🤖【任务】` 标记；跑一轮期间微信会显示「正在输入中」。

---

## 5. 注意事项 / FAQ

- **daemon 必须在运行**：本地命令会先检查，没跑会提示先 `start`。
- **本地派发时微信收不到推送（`ret=-2`）？** 若你最近没在微信和 bot 说过话（无活跃会话/`context_token`），worker 的输出推微信会被拒——但 `task-status` 在本地照样看得到。想让微信也收到，**先在微信给 bot 发一条消息**建立会话再派发。
- **同时只能跑一个任务**（单任务）：要开新的先 `结束任务` / `task-stop`。
- **它停下来 ≠ 卡住**：worker 每跑完一轮会停下等你（waiting），这是设计；你不回它就一直等，回了才续跑。
- **中断恢复**：worker 崩溃/超时会提示「回复『继续』恢复」，回 `继续` 会尝试从上次会话续上（`session/load`，不支持时 `resume`；都没有则重开）。
- **安全**：kiro 预设用 `--trust-all-tools`，能在指定目录全权操作（含 shell/写文件）；其它 agent 的批准策略不同，但同理要假设它能执行工具。微信侧靠 allowFrom 授权清单兜底；本地侧 = 能在你电脑敲命令的人（机主）。
- **DeepSeek（DSH）大脑的沙箱边界**：微信派发的 worker 工作目录默认是**用户主目录**，DSH 的 `workspace-write` 只允许写工作区+临时目录——跨盘/工作区外的写入会被拒，模型申请提权时默认**拒绝**（`WEMIND_ACP_AUTO_ALLOW=1` 才放行）。跨盘任务建议本地 `task --cwd <目标目录>` 派发或设 `WEMIND_WORKER_CWD`；另注意 cwd=主目录时 `TEMP` 在工作区内，DSH 的 pwsh 工具会报 `Windows ACL temp root must be outside the workspace`。

---

## 6. 相关环境变量（可选调）

| 变量 | 默认 | 说明 |
|---|---|---|
| `WEMIND_WORKER_CWD` | 用户主目录 | worker 默认工作目录（本地 `task --cwd` 会覆盖） |
| `WEMIND_WORKER_IDLE_MS` / `_CAP_MS` / `_FIRST_FRAME_MS` | 180000 / 1800000 / 30000 | worker 单轮空闲 / 硬上限 / 首帧超时 |
| `WEMIND_WORKER_PROGRESS` | `0` | 是否推送全程文字进度（默认安静；`1` 开启） |
| `WEMIND_TASK_SCAN_MS` | 1000 | daemon 扫描本地命令收件箱的间隔 |
| `WEMIND_WORKER_MCP_EXCLUDE` | `wechat` | worker 不继承的 MCP（`wechat` 强制排除防回环） |
