---
description: 管理 WeMind 的对话会话：新建、恢复、重命名、删除，以及切换大脑后的会话归属。
---

# 会话

WeMind 只维护一个指针：**微信当前用哪条会话**。真正的对话历史由 Agent 自己保存。

## 看会话

```bash
wemind session list
```

在微信里也可以发：

```text
会话列表
/sessions
```

列表会显示序号、名字或摘要、时间、轮次，以及 `←当前`。

## 新建

```bash
wemind session new 周报整理
```

微信里：

```text
新会话 周报整理
/new 周报整理
```

新建会清掉当前会话指针，下一条消息开始一条新会话。名字可以省略。

## 恢复

```bash
wemind session resume 3
wemind session resume 周报整理
wemind session resume 01J...
```

微信里：

```text
恢复会话 3
/resume 3
```

恢复是**严格恢复**：Agent 接不上就如实报错，不会偷偷新建一条，也不会改当前会话指针。宁可报错，也不要「假恢复」。

## 重命名与删除

```bash
wemind session rename 3 新名字
wemind session delete 3
```

微信里：

```text
重命名会话 3 新名字
删除会话 3
```

名字带空格时用引号：

```text
重命名会话 "旧的 名字" 新名字
```

删除当前会话会同时清掉当前指针，下一条消息开新会话。

## 会话属于谁

- 会话按**账号**隔离，不跨账号共用。
- 微信里的会话指令只作用于**登录者自己的**会话。
- 切换大脑不会删除旧会话；每个 Agent 的会话列表分开算。
- `brain-sessions.json` 是「当前是哪个会话」的唯一权威；`session-registry.json` 只是名字/标题/轮次等派生信息，写失败不会拖垮回合。

## 工作目录

恢复旧会话时，WeMind 会优先用它当初的工作目录（记录在 `session-cwd.json`）。如果目录不存在、是 UNC 路径或不是目录，会记一条 WARN，回落到当前默认工作区，不会把旧会话静默搬过去。

```bash
wemind workspace show
wemind workspace set /path/to/project
```

## 常见问题

**恢复后像新会话？** 先看 `wemind log --errors`。Agent 可能不支持 `session/load` 或 `session/resume`，这时 WeMind 会报错，不会假装恢复成功。

**会话列表和 Agent 里不一样？** WeMind 的列表是它自己的登记表，不是 Agent 的完整历史库。以 `brain-sessions.json` 的当前指针为准。

**切换大脑后会话去哪了？** 每个 Agent 有自己的会话。切回去后，用 `wemind session list` 看那个 Agent 名下的列表。
