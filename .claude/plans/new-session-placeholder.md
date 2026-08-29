# 新建会话即时落盘（左侧列表立即可见）

## 背景与实证结论（已完成验证）

现状：`openSession` 预设 sessionId 后 CLI 常驻，但转录 JSONL 在首条消息前不落盘，而侧栏列表 =
SDK `listSessions()` 扫描转录文件 -> 新建的空会话在侧栏不可见、不持久。

对 CLI 2.1.250 的实证（临时目录实测）：

1. CLI 启动时若转录文件已存在且指定了 sessionId -> 报 `Session ID ... is already in use` 退出
   （检查发生在首条消息前，所以"先写占位再启动 CLI"不可行）。
2. CLI 启动成功后（首条消息前）会在 `<config>/sessions/<pid>.json` 写入含 sessionId/startedAt
   的槽位登记文件；启动失败（already in use）则不写 -> 这是无竞态的"CLI 已通过启动检查"信号。
3. CLI 首条消息时对已存在的占位文件**追加**（不截断不报错），sid 保持一致，甚至会把已有
   custom-title 复写携带。
4. 手写 `{"type":"custom-title",...}` 条目即可让 `listSessions()` 列出该会话（title=customTitle），
   `getSessionMessages()` 返回 `[]`，SDK `deleteSession()` 可删除。
5. 对纯占位文件 resume -> CLI 报 `No conversation found` 退出 -> resume 降级判断必须从
   "文件存在"改为"含用户消息"；降级时需先删除占位文件（否则触发第 1 条）。
6. `renameSession` 追加的 custom-title 后写覆盖先写（last-wins）。

## 实施方案

### 后端

**`src/modules/agent/agent-session-history.ts`**

- 新增 `writeSessionPlaceholder(username, sessionId, dir)`：向 `transcriptPath` 写入
  `{type:'custom-title', customTitle:'新会话', sessionId, uuid, timestamp}` 一行（先 mkdir
  projects/<encoded> 递归；文件已存在则跳过）。
- 新增 `waitSessionSlotRegistered(username, sessionId, sinceMs)`：轮询
  `<userConfigDir>/sessions/*.json`（150ms 间隔，15s 超时），匹配 `sessionId` 且
  `startedAt >= sinceMs - 2s`（防陈旧槽位误判）。返回是否就绪。
- `userSessionTranscriptExists` -> 改为 `userSessionTranscriptHasMessages`：stat 后读文件，
  判断含 `"type":"user"` 条目（纯占位/仅 queue-op 文件视为无内容）。

**`src/modules/agent/session-registry.ts`**

- `openSession` 中：
  - resume 降级判断换用 `hasMessages`；降级时删除目标转录文件（仅占位内容，无真实消息可丢），
    沿用原 sid 按新会话开。
  - 新会话且无 firstMessage/firstImages：记 `spawnTs` -> `createSessionContext`（spawn CLI）->
    `registry.set` -> `await waitSessionSlotRegistered` -> 成功则 `writeSessionPlaceholder`
    （best-effort，失败仅 warn 日志，不 fail 开启）；置 `ctx.untitled = true`。
  - `SessionContext` 增加 `untitled: boolean`（占位标题待首条消息改写；resume/带首条消息的
    开启为 false）。

**`src/modules/agent/agent.service.ts`**

- `sendMessage`：push 成功后若 `ctx.untitled` 且 text 非空 -> 置 false 并 fire-and-forget
  `renameUserSession(username, sid, dir, 首条消息摘要)`（catch + warn 日志）。摘要取首行去空白、
  按码点截 ~50 字符。恢复既有 UX（标题≈首条消息），否则侧栏永远显示"新会话"。

### 前端

**`ui/src/pages/ChatPage.tsx`**

- `handleNewSession`：`openNewSession` 成功（outcome 非空）后 `setRefreshNonce(n => n + 1)`，
  侧栏立即重拉显示"新会话"条目（排在最前，lastModified=mtime=now）。

### 行为闭环检查

- 新建 -> 响应返回时已落盘可见（等待 CLI 槽位 ~1s，openSession 响应变慢一点，可接受）。
- 首条消息 -> CLI 追加到占位文件，turn 结束侧栏刷新 -> 标题改为消息摘要。
- 空会话被关闭/GC/重启 -> 占位文件保留，会话持续存在于列表；可被删除（SDK delete 已验证）。
- 点击列表中的空会话 -> hasMessages=false -> 删占位 -> 同 sid 新开 -> 槽位就绪后重写占位，
  列表条目不消失。
- 真实会话 resume -> hasMessages=true -> 走原 resume 路径，无行为变化。
- 带 firstMessage 开启 -> 跳过占位（转录马上由 CLI 落地），无回归。

### 测试与自检

- `agent.test.ts` 补纯 FS 单测（临时目录）：占位写入后被 hasMessages 判为无消息；写入 user 行后
  判为有消息；占位删除；标题摘要函数。
- 交付自检：`bun run typecheck && bun run lint && bun test` 全绿。

## 不做的事

- 不改路由/ schema/ 错误码；不动 `src/core/**`。
- 不做前端合成条目（后端真落盘后无必要）。
- 不引入 DB 会话表（架构以 SDK JSONL 为会话真源，保持一致）。
