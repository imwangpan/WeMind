# 接入 GitHub Copilot CLI

> **2026-11-13 口径**：默认 `homeMode=direct`，WeMind 在 daemon 启动/运行期不自动写 Agent 配置（显式 `wemind config agent ...` 例外），Agent 直接读真实 home，并与终端共享配置、技能、记忆与会话库；本文涉及 `brain-home` / `worker-home` 的描述仅适用于显式 `homeMode=managed`。

> **最后核对**：2026-11-15 ｜ **实测环境**：Windows 11、Node 24.21.0、GitHub Copilot CLI 1.0.108 ｜ **状态**：✅ 已内置预设并通过 ACP 探针与真机 E2E。

Copilot CLI 原生支持 ACP，可作为 WeMind 的对话大脑与任务 worker。内置 `copilot` 预设默认 `direct`：不注入 `COPILOT_HOME`，由 Agent 直接读真实配置；`managed` 才把 `COPILOT_HOME` 指向账号副本，并同步登录配置与个人指令/技能。MCP 一律由 Copilot 自己读 `mcp-config.json`（它不消费 ACP `mcpServers`）：`direct` 用真实目录，`managed` 由 WeMind 把激活集/全量集写进副本的 `mcp-config.json`，并永久排除 `wechat`。

## 1. 安装与认证

安装 GitHub Copilot CLI 并确认 `copilot` 在 daemon 的 `PATH` 中。Windows 上 npm 全局安装会提供 `copilot.cmd`；WeMind 预设使用 `shell: true` 经系统 shell 启动，PowerShell 配置即可，不依赖 Git Bash。

先在当前 Windows 用户下登录：

```powershell
copilot login
copilot --version
```

`direct` 下不注入 `COPILOT_HOME`，Agent 直接用真实 `~/.copilot`；`managed` 才把 `~/.copilot/config.json` 同步到副本。无人值守环境也可使用 Copilot CLI 支持的 `COPILOT_GITHUB_TOKEN`、`GH_TOKEN` 或 `GITHUB_TOKEN`，由 daemon 进程继承，**不要写进 brain 配置或源码**。若真实配置目录不是默认的 `~/.copilot`，启动 daemon 前用 `WEMIND_BRAIN_REAL_HOME` 指向该目录。

## 2. 预设与 direct / managed

配置预设等价于：

```ts
copilot: {
  bin: "copilot",
  binWin: "copilot.cmd",
  args: ["--acp", "--no-auto-update", "--allow-all-tools"],
  shell: true,
  homeEnvVar: "COPILOT_HOME",
  realHome: path.join(os.homedir(), ".copilot"),
  inheritDirs: ["skills"],
  inheritFiles: ["copilot-instructions.md"],
  credentialFiles: ["config.json"],
  mcpConfigFile: "mcp-config.json",
  catalogFile: "mcp-config.json",
  mcpDelivery: "config",
}
```

`--allow-all-tools` 让 daemon 无需交互即可批准工具调用；它不等于 `--allow-all`，不会主动放宽路径或 URL 检查。Copilot 不参与 `auto` 探测：二进制存在不代表该运行账号已完成认证，使用 `copilot` 名称显式选择。

`direct` 下 Copilot 自己从 `~/.copilot/mcp-config.json` 加载 MCP，WeMind 不重发 catalog；`managed` 下由 WeMind 把激活集/全量集写进副本的 `mcp-config.json`（`mcpDelivery: "config"`），按名称和定义排除 `wechat`。**不走 ACP 投递**：Copilot 的 `initialize` 只声明 `mcpCapabilities: {http, sse}`，1.0.108 实测 `session/new.mcpServers` 传入的 stdio 条目不加载。Copilot CLI 登录配置在 `config.json`，而 MCP 配置单独存放；WeMind 只同步/生成登录配置，不复制插件/hooks。

## 3. 探针实测

`scripts/acp-probe.mjs` 使用 `copilot.cmd --acp --no-auto-update --allow-all-tools`（Windows，2026-11-09 起，2026-11-15 复测 1.0.108）：

- `initialize`、`session/new`、流式 `session/update`、`session/load` 成功；强杀后恢复同一 session 并答出此前提示词中的秘密词。
- 图片 prompt 被 ACP 接收。2026-11-09 那次本机 Auto 模型拒绝 1×1 PNG（CLI 提示后退化为不带图重试）；2026-11-15 复测，1×1 PNG 被接受并正常 `end_turn`（2.3s），不再回退。不同模型的图像能力可能仍有差异。
- `initialize` 只声明 MCP HTTP/SSE；把 stdio MCP 通过 `session/new.mcpServers` 传入（普通写法与带 `type: "stdio"` 两种）模型都答「没有这个工具」，`toolCalls: 0`。**早期 2026-11-09 记录的 `PONG` 结论在 1.0.108 无法复现**，以本次为准：MCP 只认自己的 `mcp-config.json`。
- 默认不开 `--allow-all-tools` 时文件工具触发 `session/request_permission` 并被 WeMind 探针拒绝；加该参数后，测试文件在临时工作目录成功写入，且未产生权限反向请求。
- `--acp` 输出包含 usage/tool/thought 等 activity 帧。短 prompt 首段正文约 6 秒；带 MCP 工具的测试约 18 秒。

以上是本机单次探针结果，不代表其它 CLI 版本或模型的行为。

## 4. 限制与风险

- Copilot 登录是硬前置；`managed` 下 `COPILOT_HOME` 指向新副本时若 CLI 报 `Authentication required`，检查 `config.json` 是否同步，或给 daemon 提供 Copilot CLI 支持的 token 环境变量。
- 图像由 CLI 与当前模型共同决定。ACP 接受图像；早期本机 Auto 模型曾拒绝并退回文本，2026-11-15 复测已通过。该结果不保证其它模型/网关相同。
- 预设不启用 Copilot 自动更新，需按上游方式自行更新 CLI，并重新运行 ACP 探针。
- brain 与 worker 链路均已跑通（见文末实测补充）；多账号按 `direct` 的共享语义运行（各账号独立 daemon，Agent 真实配置单机共享）；尚未验证模型切换与其它平台的 npm shim 与认证行为。

## 5. 验证

```powershell
copilot login
wemind brain set copilot --restart
wemind brain check copilot
```

如不重启且 daemon 正在运行，可执行 `wemind brain switch copilot`。再确认 `wemind brain` 显示 Copilot，并用一条普通消息和一条任务验证 brain/worker。

## 待实测

- WeChat `加载/卸载 MCP`：`direct` 下原样转给 Copilot 自己改 `~/.copilot/mcp-config.json`（实测不消费 ACP `mcpServers`）；`managed` 由 WeMind 写副本 `mcp-config.json`。
- 非 Windows 平台行为，以及 `COPILOT_HOME` 自定义目录的登录兼容性。

**2026-11-14 实测补充（`direct`）**：worker 真机已跑通（本地任务桥派发 + 多轮追问）。技能目录就是真实 `~/.copilot/skills`：新增 skill 后**新会话**可见 ✅（此前探针报 `SKILLS=none` 只是因为该目录当时是空的），同一会话内新增 skill **不会**即时刷新（需新会话）；微信侧让它写文件能落到真实 home ✅。会话可见性 ✅：`~/.copilot/session-state/<sessionId>/`（目录名 = `session/new` 返回的 sessionId）。来源：设计文档 §18.5。

**2026-11-15 复测**：两轮 prompt + 重启后 `session/load` 通过、上下文保持（两个并发进程同时跑也通过）；强制工具调用 0 次权限请求、标记文件落盘；图片 1×1 PNG 被接受并正常 `end_turn`；`session/new` 传 `mcpServers` **不加载**（普通写法与带 `type: "stdio"` 都不认，`toolCalls: 0`），故预设改为 `acpMcpServers: false` + `mcpDelivery: "config"`，MCP 只走它自己的 `mcp-config.json`。来源：设计文档 §18.6、§18.8。
