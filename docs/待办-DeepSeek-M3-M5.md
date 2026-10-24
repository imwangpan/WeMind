# 待办：DeepSeek（官方 DSH）后续 M3–M5

> **状态（2026-10-24 更新）**：**M3 ✅ 已实现并真机验证；M4 ✅ 已验收（现场已还原）；M5 除「图片（上游限制）」与「双真机微信账号」外均完成。**
> **已完成**：M1（预设/沙箱/凭据）、M2（model 选择、resume 兜底、反向请求、首帧/心跳、图片拦截）、M5-1（worker E2E）。
> **现行入口**：[`docs/接入-DeepSeek.md`](接入-DeepSeek.md)。

---

## M3 · 动态 MCP 注入（via ACP）✅ 已实现并验证（2026-10-24）

**目标**：让微信里的「加载/卸载 MCP」对 DeepSeek 生效，且不要求 DSH 读 kiro 的文件。

**现状**：已实现。预设 `mcpViaAcp: true`；`applySandbox`/`syncSettings` 跳过文件写入；`agent-mcp.ts` 新增 `toAcpMcpServers()`（kiro/opencode/remote → ACP stdio/HTTP 声明，坏条目进 skipped）；`activeMcpServers()`/`workerMcpServers()` 把（brain 激活集 / worker 全量除排除集）转换后随 `session/new|resume` 下发；`addMcp` 加载前预校验。

**验证（真机，dsh 0.2.1-rc.2）**：

- 假 stdio MCP（echo 工具，被调用时写 marker）：`session/new` 挂载成功，模型调用工具 → marker 第 1 次 `called`，回答 `ok`；
- `session/resume` 带同一 `mcpServers` → 模型再次调用 → marker 第 2 次 `called`，回答 `okPINEAPPLE`（上下文保留）；
- **坏条目回滚验证**：起不来的 MCP 让 `session/new` 直接失败（`mcp-client: initial connection or tool synchronization failed`）——因此 `addMcp` 预校验拒绝无法转换的定义，`toAcpMcpServers` 跳过坏条目并记日志；
- 单测：`agent-mcp.test.ts`（转换/跳过/排除/预校验）、`brain-agents.test.ts`（mcpViaAcp 解析），全量 136 tests 通过。

**遗留**：HTTP MCP 未真机实测（`http:true` 已广告）；catalog 默认来源仍是 `~/.dsh/settings/mcp.json`（不存在 → 需 `WEMIND_MCP_CATALOG` 指向中立文件）。

---

## M4 · 记忆 / 技能继承 ✅ 已验收（2026-10-24，现场已还原）

**目标**：确认微信里的 DSH 与桌面端读到同样的 skills / AGENTS.md，且 worker 同步。

**验证**：在真实 `~/.dsh` 放临时测试 skill（`wemind-m4-test`，secret `KIWANO`）与 `AGENTS.md` 规则（code word `MANGO-42`）：

- `brain-home/skills/wemind-m4-test`（junction）与 `worker-home/skills/...` 均可读；两沙箱 `AGENTS.md` 均含规则；
- brain 回答 `CODEWORD=MANGO-42 SECRET=KIWANO`；worker 同样 `CODEWORD=MANGO-42 SECRET=KIWANO`（规则 + 技能都被遵守）；
- `~/.agents/skills` 共享根本机不存在（读不到，符合预期）；
- 验证后已删除测试 skill 与 `AGENTS.md`，`~/.dsh` 还原（保留空 `skills/` 目录，避免账号沙箱 junction 悬空）。

---

## M5 · 加固与覆盖（除标注外均完成）

1. **worker E2E** ✅ 2026-10-24：`task "create hello.txt" --cwd <临时目录>` → 文件内容 `hello` + 输出 `DONE`；`task-reply "read hello.txt"` → 输出 `hello`；`task-stop` → idle。日志：`[wemind/wechat-daemon/worker] spawn deepseek ... → model set → session/new → prompt ok`（2305ms / 1575ms）。
2. **图片**（待上游）：官方 `image:false`；已实现友好拒绝 + ACP 级 `-32602` 验证。跟进官方打开 `image` 后移除拦截并回归；微信端发图实测待用户配合。
3. **多账号** ✅ 机制已验证（2026-10-24）：两个独立数据目录各跑一轮 brain → 各自 `brain-home`/`worker-home` 均有独立 `.credentials.yaml`，`brain-sessions.json` 的 sessionId 不同，均正常回答；双**真机微信**账号（需第二个扫码登录）待用户需要时再验。
4. **升级守卫** ✅：`scripts/doctor.ps1` 比对 `dsh --version` 与已实测版本（0.2.1-rc.2），不一致时提示先跑 `scripts/acp-probe.mjs` 回归。
5. **测试** ✅：`toAcpMcpServers`/预校验/`mcpViaAcp` 单测（全量 136 通过）；`set_config_option` 失败路径真机验证（非法 model → `-32602 unknown model option`，随后在默认路由明确报 no API key，不静默）。
6. **文档** ✅：M3/M4/M5 结果已回填本文与 `接入-DeepSeek.md` 附录；`add-mcp` 配方、README、CHANGELOG 同步。

---

## 当前建议的边界（非用户决策）

> 下面三条是**建议/当前草案**，不是已经拍板的决定；后续范围以立项时讨论为准。

- **暂不引入社区 `deepseek-acp`**：按当前选择先用官方 DSH；如果遇到官方无法解决的硬限制（目前是 `image:false`），再讨论是否引入。
- **暂不抽 `Brain` 接口**：这是当前建议，不是已定决策；等真的要做裸 API 大脑时再评估。
- **M3 当前只规划 tools**：resource/prompt 是否纳入，等后续立项时再定；本文没有“resource/prompt 不接”的既定结论。
