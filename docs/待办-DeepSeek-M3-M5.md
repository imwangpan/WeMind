# 待办：DeepSeek（官方 DSH）后续 M3–M5

> **状态**：M3/M4 暂不实施；M5 的 **worker E2E 已于 2026-10-24 完成**，其余项仍待办（按用户要求）。
> **已完成**：M1（预设/沙箱/凭据）、M2（model 选择、resume 兜底、反向请求、首帧/心跳、图片拦截）、M5-1（worker E2E）。
> **现行入口**：[`docs/接入-DeepSeek.md`](接入-DeepSeek.md)。

---

## M3 · 动态 MCP 注入（via ACP）

**目标**：让微信里的「加载/卸载 MCP」对 DeepSeek 生效，且不要求 DSH 读 kiro 的文件。

**现状**：未实现。`deepseek` 预设仍走默认 `mcpFormat: "kiro"`，会写一个 DSH 不读的 `settings/mcp.json`；`加载/卸载` 对 DSH 无效。

**要做**：

1. 预设加 `mcpViaAcp: true`；`mcp-sandbox` 在 `mcpViaAcp` 时跳过文件写入与 `syncKiroSettings`。
2. 新增 `toAcpMcpServers(catalog, format)`：
   - kiro `{ command, args, env }` → `{ name, command, args, env }`；
   - opencode `{ type: "local", command: [...], environment }` → 拆 `command[0]` / `args` / `env`；
   - remote → `{ name, type: "http", url, headers }`（SSE 不支持，跳过）；
   - 始终排除 `wechat`。
3. `ensureSession` 把激活集转成 `mcpServers`，传给 `session/new` / `session/resume`；`session/resume` 也要带，否则恢复后 MCP 丢失。
4. catalog 来源：DSH 自身没有 kiro 式文件时用 `WEMIND_MCP_CATALOG` 指向中立 kiro 格式文件；**不要让 DSH 读 kiro 的配置**。
5. 坏条目预校验：官方 `session/new` 失败会回滚整个会话，加载前先验证 command/URL。

**验收**：

- `加载 <MCP>` → `session/new`/`resume` 带 `mcpServers` → 模型能调用该工具；`卸载` 后重启不再出现；
- `wechat` 仍被拒绝；
- 一个坏 MCP 不会把整个会话打挂（有告警/跳过）。

**风险**：stdio MCP 已实测被 `session/new` 接受，但工具列表尚未断言；HTTP 已广告，SSE 不支持。

---

## M4 · 记忆 / 技能继承（完整验收）

**目标**：确认微信里的 DSH 与桌面端读到同样的 skills / AGENTS.md，且 worker 同步。

**现状**：预设已配置 `realHome=~/.dsh`、`inheritDirs=["skills"]`、`inheritFiles=["AGENTS.md"]`；尚未做真机「放一个 skill → 微信触发 → 命中」验证。

**要做**：

1. 在 `~/.dsh/skills` 放一个测试 skill（如 `wemind-test/SKILL.md`），确认 `brain-home/skills` junction 生效；
2. 在 `~/.dsh/AGENTS.md` 写一条可识别规则，确认微信大脑遵守；
3. 检查 `~/.agents/skills` 共享根是否也被读到（`DSH_AGENTS_HOME` 默认不指向沙箱）；
4. worker `WORKER_HOME` 同样验证；
5. 记录 DSH 的 skills 目录布局（`$DSH_HOME/skills`、`~/.agents/skills`）与 junction 行为。

**验收**：测试 skill 能被模型按需加载；AGENTS.md 规则生效；brain/worker 一致；删除测试文件后不残留。

**风险**：Windows junction 权限、skills frontmatter 校验、token 刷新与 `.credentials.yaml` 的覆盖顺序。

---

## M5 · 加固与覆盖

**目标**：把「能用」变成「可长期维护」。

**待办**：

1. **worker E2E** ✅ 2026-10-24：`task "create hello.txt" --cwd <临时目录>` → 文件内容 `hello` + 输出 `DONE`；`task-reply "read hello.txt"` → 输出 `hello`；`task-stop` → idle。日志：`[wemind/wechat-daemon/worker] spawn deepseek ... → model set → session/new → prompt ok`（2305ms / 1575ms）。
2. **图片**：官方 `image:false` 是上游限制；当前已友好拒绝。跟进官方是否打开 `image`，打开后移除拦截并回归。
3. **多账号**：两个账号分别 `brain.json`/`brain-home`/`worker-home`，互不抢 session；确认 `.credentials.yaml` 各自同步。
4. **升级守卫**：锁 `0.2.1-rc.2`；升级前跑 `scripts/acp-probe.mjs`，确认 `resume`、model、MCP 能力未变。
5. **测试**：补 `deepseek` 预设的 `credentialFile`/`images`/`restore` 单测（已有基础断言）；补 `applyModel` 失败路径；`brain check` 60s 回归。
6. **文档**：`llms.txt`/`AGENTS.md` 已包含；后续把 M3/M4 的验收结果回填。

**验收**：上表每项有命令/日志/输出；微信 E2E 与 worker E2E 各一条完整记录。

---

## 明确不做（除非需求变化）

- 不引入社区 `deepseek-acp`；只用官方 DSH。
- 不为单一 ACP 实现抽 `Brain` 接口；等裸 API 大脑立项再抽。
- 不在 M3 之外扩展 MCP（resource/prompt 不接）。
