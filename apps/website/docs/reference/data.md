---
description: WeMind 的账号目录、会话/任务文件、媒体缓存与重置方式。
---

# 数据目录

默认根目录是 `~/.wemind`。每个账号一个子目录，互不共用会话、任务、工作区和媒体。

## 布局

```text
~/.wemind/
  .agents/                 # 单机共享的 Agent 定义与 .sources.json
  <account-key>/
    account.json           # 登录凭证
    state.json             # 游标、去重环等
    brain.json             # 当前对话/任务大脑
    brain-sessions.json    # 当前会话指针（权威）
    session-registry.json  # 会话名字/标题/轮次（派生）
    session-cwd.json       # <agent>:<sessionId> → cwd
    worker-sessions.json   # 任务会话指针
    tasks.json             # 未完成任务（重启后续跑）
    workspace.json         # 默认工作区
    brain-mcps.json        # managed 模式的 MCP 激活集
    runtime.json           # 待重启标记等
    media/inbound/         # 入站图片/文件/视频
    daemon.log             # 运行日志
```

`<account-key>` 由 bot 身份派生，不是 label。`label` 只是别名；改 label 不会换目录。

## 会话与任务文件

| 文件 | 作用 |
| --- | --- |
| `brain-sessions.json` | 微信当前用哪条会话；**唯一权威** |
| `session-registry.json` | 名字、标题、轮次；写失败只记日志，不拖垮回合 |
| `session-cwd.json` | 恢复旧会话时用哪个工作目录 |
| `worker-sessions.json` | 任务会话指针 |
| `tasks.json` | 只用于“重启后续跑”，不自动 spawn，不做历史归档 |
| `runtime.json` | `pendingReload` 等运行期标记 |

## 媒体

- `direct`：`<账号>/media/inbound`
- `managed`：`<managed>/media/inbound`；worker 写 `worker-home/media/inbound`
- 默认保留 30 天、总量 1GB；启动时清理，之后写入时检查，最多每小时一次。
- 目录权限 0700，文件 0600。

## 日志

```bash
wemind log [key|label] [--lines N] [--errors] [--file N]
```

日志是 `daemon.log` 的尾部快照，没有 `--follow`。实时跟：

```bash
tail -f ~/.wemind/<key>/daemon.log
```

## 迁移

1. 停掉 daemon：`wemind stop`。
2. 复制整个账号目录到新位置。
3. 用 `WEMIND_HOME` 指向新根目录，或把旧目录做成链接/junction。
4. 启动并验证：`wemind list`、`wemind log --errors`。

> 不要只复制 `brain-sessions.json` 或 `tasks.json`；会话、附件、工作区是配套的。

## 重置

```bash
wemind logout        # 退出登录，保留部分数据
wemind delete        # 删除账号数据
```

彻底重来：先 `wemind stop`，再删除 `~/.wemind/<key>`，然后重新 `wemind login`。

## 多账号

```bash
wemind login --label 工作号 --start
wemind login --label 生活号 --start
wemind list
```

每个账号独立目录、独立 daemon、独立登录者；没有“主号”。`wemind list` 的 key 才是目录名，label 只是给人看的。

## 安全

- `account.json` 含登录 token；POSIX 权限 600，Windows 上是明文，注意磁盘加密/账户权限。
- 不要把 `~/.wemind` 提交到 git，也不要整目录打包发给别人。
- `media/inbound` 可能含聊天中的图片/文件；清理前确认不再需要。
