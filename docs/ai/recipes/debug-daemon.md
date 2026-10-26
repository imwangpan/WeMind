# 配方：排查 daemon 不回复 / 大脑异常

> **适用版本**：WeMind 1.0.1 ｜ **最后核对**：2026-10-24
>
> 先跑 [`scripts/doctor.ps1`](../../../scripts/doctor.ps1) 收集环境事实，再按症状定位。不要一上来改代码。

---

## 0. 30 秒分诊

| 症状 | 先看 | 大概率原因 |
|---|---|---|
| `wemind start` 立刻退出 / 日志 `FATAL 大脑不可用`（exit 78） | `wemind brain` | 预设未知、二进制不在 PATH、`binWin` 写错（如只有 `dsh.cmd`） |
| daemon 在跑，但微信完全没反应 | `daemon.log` 有无 `turn start` / `prompt ok` | 没登录、allowFrom 不含你、bot token 被另一个消费者抢走 |
| 反复「⏳ 响应中断了，正在自动重试…」 | `daemon.log` 的 `[wemind/wechat-daemon/acp]` | agent 启动失败、`initialize` 超时、参数不对、`.cmd` 没经 shell |
| 回复突然停 / 「接近微信连续消息上限」 | 进度条数 | iLink 连发上限 ~10；回「继续」恢复 |
| 重启后「它忘了」 | `session/load failed` / `session/resume` | agent 不支持 load，或 resume 参数/cwd 不对 |
| 发图报错/重试 | `prompt FAIL` + `-32602` | agent `image:false`（如 DSH 官方） |
| 桌面已登录但报 `no API key for ... deepseek-official` | 预设的 model / 路由 | DSH 默认路由要 API key；桌面登录对应 `deepseek-account`，需 `set_config_option` 切换 |
| 多账号互相抢消息 | `list` / 进程 | 同一 bot token 起了多个 daemon，或 brain 加载了 `wechat` MCP |
| worker 任务不动 | `task-status` | worker 超时/权限/agent 不支持；看 `.../worker` 日志 |

---

## 1. 事实收集

```powershell
# 环境 / 账号 / 大脑 / agent 二进制
pwsh -NoProfile -File scripts/doctor.ps1

# 下面统一写 `wemind`（已发布：npm i -g @wemind/cli）。
# 从源码排查时等价于 `node packages/wechat-daemon/dist/cli.js <子命令>`。

# 版本（先确认用户/自己用的是哪一版）
wemind version

# 账号与状态
wemind list

# 大脑解析（某账号）
wemind brain <key|label>

# 真机 ACP 握手（initialize + session/new）
wemind brain check <key|label>
```

> `brain check` 默认 20s；冷启动慢的 agent 可能超时。先看它打印的 stderr，再判定「不可用」。

---

## 2. 看日志

默认数据目录：`~/.wemind/<key>/`

| 文件 | 用途 |
|---|---|
| `daemon.log` | daemon / acp / worker / task / watchdog 日志 |
| `brain.json` | 账号级大脑选择 |
| `brain-sessions.json` | `<agent>:userId → sessionId`（按大脑分命名空间） |
| `brain-mcps.json` | 当前激活的 MCP |
| `brain-home/` | brain 沙箱（agent 配置/会话） |
| `worker-home/` | worker 沙箱 |
| `daemon.pid` / `brain.pid` / `worker.pid` | 进程定位 |

关键日志：

```text
[wemind/wechat-daemon] turn start to=... msgAge=...
[wemind/wechat-daemon/acp] spawn <agent> acp pid=... bin=... args=[...]
[wemind/wechat-daemon/acp] initialized
[wemind/wechat-daemon/acp] session/new ok ...  |  session/load ok ...  |  session/load failed (...), creating new
[wemind/wechat-daemon/acp] → session/prompt#...
[wemind/wechat-daemon/acp] prompt ok ... chunks=N updateTypes=[...]
[wemind/wechat-daemon] replied to ...
```

---

## 3. 常见修法

### 3.1 大脑不可用（exit 78）

```powershell
wemind brain                 # 看 requested / source / 生效 bin
wemind brain set kiro        # 或 opencode / 其它已装预设
wemind brain check
```

- 预设未知 → `brain set` 会列出可选值；
- 二进制找不到 → 安装，或 `brain set <预设> --bin <绝对路径>`；
- Windows 只有 `.cmd` → 预设 `binWin` 必须是实际文件名（`dsh.cmd`）；`onPath()` 不会自动补 `.cmd`；
- 自定义 agent → `WEMIND_BRAIN_BIN` / `WEMIND_BRAIN_ARGS` / `WEMIND_BRAIN_HOME_ENV`。

### 3.2 daemon 在跑但不回复

1. `wemind list` 确认账号 `运行中`；
2. 确认你已在 `allowFrom`：`wemind allowlist <key>` / `wemind allow <key> <userId>`；
3. 看 `daemon.log` 有没有 `turn start`：
   - 没有 → 消息没被拉取（登录/token/多消费者）；
   - 有但没有 `prompt ok` → ACP 层问题，转 3.3；
4. 确认没有第二个 MCP/daemon 用同一 token（回环/抢消息）。

### 3.3 ACP 启动/握手失败

```powershell
# 手动起一次，确认它能说 ACP
wemind brain check

# 或直接看 spawn 参数
wemind brain
```

- `spawn` 后立刻 `acp exited` → 二进制/参数/`shell` 不对；
- 卡在 `initialize` → 不是 ACP，或参数没进入 ACP server 模式；
- Windows `.cmd`/`npx` → `shell: true`（预设或 `WEMIND_BRAIN_SHELL=1`）；
- 路径含空格/`&` → 用绝对路径 + `shell`，并确认 `spawnAgent` 的引号逻辑；
- 反向请求无应答 → 现在会静默丢弃；接入新 agent 时先做应答器（见 `docs/ai/recipes/add-acp-agent.md`）。

### 3.4 重启后上下文丢失

```powershell
# 看日志有没有：
#   session/load failed (...), creating new
#   session/load ok | session/resume ok
```

- agent 不支持 `session/load` → 需要 `session/resume` 兜底；DSH 属此类；
- `resume` 失败 → 检查 `cwd`、`mcpServers`、会话是否已持久化；
- 想彻底重来 → 微信「新会话」，或删 `brain-sessions.json` + `brain-home/sessions/`。

### 3.5 连发上限 / 进度刷屏

- 现象：一串「还在思考」「仍在处理」，然后「接近上限，我先暂停进度」；
- 原因：无 `session/update` 帧时，`index.ts` 每 15s 发一条进度；
- 处置：让用户回「继续」恢复；接入 committed-only agent 时调 `heartbeatMs` / 降低进度频率。

### 3.6 图片失败

```text
prompt FAIL ... -32602 Invalid params: inline image prompts were not advertised
```

- agent `initialize.promptCapabilities.image=false`；
- DSH 官方 0.2.1-rc.2 属此类；换支持图片的 agent，或在 `askBrain` 前拦截并友好提示。

### 3.7 桌面登录了但报 no API key（DSH）

```text
-32603 Internal error: turn failed: llm-deepseek: no API key for provider route "deepseek-official"
```

- `session/new` 默认模型是 `deepseek-official/*`，需要 `DEEPSEEK_API_KEY`；
- 桌面端登录态是 `deepseek-account/*`，必须在 `session/new` 后用 `session/set_config_option` 切换：
  `{ sessionId, configId: "model", value: "[\"deepseek-account\",\"deepseek-flash\"]" }`；
- 预设层应加 `model` 字段；`resume` 会保留上次选择，但配置变更后要重设；
- 如果坚持 official 路由，就配 `DEEPSEEK_API_KEY`（daemon 环境）。

---

## 4. 不要做的事

- 不要为了「让它回」而关掉 `allowFrom`；
- 不要让 brain 加载 `wechat` MCP；
- 不要在同一 token 上同时跑 MCP 形态与 daemon；
- 不要把 `WEMIND_BRAIN*` 写进系统 profile 当默认（用 `brain.json`）；
- 不要在文档里把「未实测」写成「已支持」。

---

## 5. 参考

- [`docs/repowiki/05-守护进程-Daemon.md`](../../repowiki/05-守护进程-Daemon.md)
- [`docs/repowiki/06-ACP-大脑与沙箱.md`](../../repowiki/06-ACP-大脑与沙箱.md)
- [`docs/repowiki/10-部署与运维.md`](../../repowiki/10-部署与运维.md)
- [`docs/daemon-常驻原理.md`](../../daemon-常驻原理.md)
