# 接入 GitHub Copilot CLI

> **2026-11-13 口径**：默认 `homeMode=view`，微信侧使用 `<账号>/agent-view/<role>/<agent>/` 配置视图，并与终端共享真实配置、技能、记忆与会话库；`direct` 不生成视图、由 Agent 直接读真实配置；本文涉及 `brain-home` / `worker-home` 的描述仅适用于显式 `homeMode=sandbox`。

> **最后核对**：2026-11-12 ｜ **实测环境**：Windows 11、Node 24.21.0、GitHub Copilot CLI 1.0.107 ｜ **状态**：✅ 已内置预设并通过 ACP 探针；WeChat brain/worker 真机 E2E 待验证。

Copilot CLI 原生支持 ACP，可作为 WeMind 的对话大脑与任务 worker。内置 `copilot` 预设把 `COPILOT_HOME` 指向配置视图（`view`）或账号沙箱（`sandbox`）；`direct` 不注入 `COPILOT_HOME`、由 Agent 直接读真实配置。登录配置与个人指令/技能按模式链接或同步；`view` / `sandbox` 下 MCP 按 WeMind 激活集经 ACP 提供，`wechat` 始终排除；`direct` 下 MCP 由真实配置决定。

## 1. 安装与认证

安装 GitHub Copilot CLI 并确认 `copilot` 在 daemon 的 `PATH` 中。Windows 上 npm 全局安装会提供 `copilot.cmd`；WeMind 预设使用 `shell: true` 经系统 shell 启动，PowerShell 配置即可，不依赖 Git Bash。

先在当前 Windows 用户下登录：

```powershell
copilot login
copilot --version
```

预设会把 `~/.copilot/config.json` 同步到各自的 `COPILOT_HOME` 配置视图/沙箱；用户 MCP 配置文件不会复制。无人值守环境也可使用 Copilot CLI 支持的 `COPILOT_GITHUB_TOKEN`、`GH_TOKEN` 或 `GITHUB_TOKEN`，由 daemon 进程继承，**不要写进 brain 配置或源码**。若真实配置目录不是默认的 `~/.copilot`，启动 daemon 前用 `WEMIND_BRAIN_REAL_HOME` 指向该目录。

## 2. 预设与配置视图/沙箱

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
  catalogFile: "mcp-config.json",
  mcpViaAcp: true,
}
```

`--allow-all-tools` 让 daemon 无需交互即可批准工具调用；它不等于 `--allow-all`，不会主动放宽路径或 URL 检查。Copilot 不参与 `auto` 探测：二进制存在不代表该运行账号已完成认证，使用 `copilot` 名称显式选择。

大脑从 `~/.copilot/mcp-config.json` 读取 MCP 目录，默认不激活；worker 使用同一目录里的可用 MCP。两者都通过 ACP `mcpServers` 传递，WeMind 按名称和定义排除 `wechat`。Copilot CLI 登录配置在 `config.json`，而 MCP 配置单独存放；WeMind 只同步/生成登录配置，不复制 MCP/插件/hooks。

## 3. 探针实测

`scripts/acp-probe.mjs` 使用 `copilot.cmd --acp --no-auto-update --allow-all-tools`（Windows，2026-11-09）：

- `initialize`、`session/new`、流式 `session/update`、`session/load` 成功；强杀后恢复同一 session 并答出此前提示词中的秘密词。
- 图片 prompt 被 ACP 接收；本次 Auto 模型拒绝 1×1 PNG，CLI 提示后退化为不带图重试。不同模型的图像能力可能不同，属于待复测项。
- `initialize` 只声明 MCP HTTP/SSE，但把 stdio MCP 通过 `session/new.mcpServers` 传入后，模型实际调用测试工具并答出 `PONG`；不能仅按 capabilities 字段推断。
- 默认不开 `--allow-all-tools` 时文件工具触发 `session/request_permission` 并被 WeMind 探针拒绝；加该参数后，测试文件在临时工作目录成功写入，且未产生权限反向请求。
- `--acp` 输出包含 usage/tool/thought 等 activity 帧。短 prompt 首段正文约 6 秒；带 MCP 工具的测试约 18 秒。

以上是本机单次探针结果，不代表其它 CLI 版本或模型的行为。

## 4. 限制与风险

- Copilot 登录是硬前置；`COPILOT_HOME` 指向新的视图/沙箱时若 CLI 报 `Authentication required`，检查 `config.json` 是否同步，或给 daemon 提供 Copilot CLI 支持的 token 环境变量。
- 图像由 CLI 与当前模型共同决定。探针里 ACP 接受图像，但实际模型拒绝并退回文本；该结果不保证其它模型相同。
- 预设不启用 Copilot 自动更新，需按上游方式自行更新 CLI，并重新运行 ACP 探针。
- 尚未验证 WeChat brain/worker 的完整真实消息链路、多账号隔离、模型切换，以及其它平台的 npm shim 与认证行为。

## 5. 验证

```powershell
copilot login
wemind brain set copilot --restart
wemind brain check copilot
```

如不重启且 daemon 正在运行，可执行 `wemind brain switch copilot`。再确认 `wemind brain` 显示 Copilot，并用一条普通消息和一条任务验证 brain/worker。

## 待实测

- WeChat brain/worker 真机端到端、重启后会话恢复及 MCP 加载/卸载。
- Copilot CLI 后续版本的图片模型支持、非 Windows 行为，以及 `COPILOT_HOME` 自定义目录的登录兼容性。
