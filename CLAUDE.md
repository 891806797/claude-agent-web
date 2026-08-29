# CLAUDE.md

Bun + Hono + Drizzle ORM + PostgreSQL 后端 + Web 版 Claude Code（基于 @anthropic-ai/claude-agent-sdk）。

## ⚠️ 开发任何功能前，先读《开发规范.md》

- **活教材**：`src/modules/auth/` 是标准业务模块范式（7 文件分层）；`src/modules/agent/` 是复杂业务模块（含 SSE/注册表/SDK 集成）的进阶参考
- **前端**（ui/）规范见《开发规范.md》第 12 节；活教材 `ui/src/pages/ChatPage.tsx`、`AdminPage.tsx`；格式化用 ui 内 prettier（biome 不管 ui/）
- **禁区**：`src/core/**` 默认禁止修改（`core/error-codes.ts` 仅允许追加错误码）

## 常用命令

| 命令 | 说明 |
|---|---|
| `bun run dev` | 启动开发服务（热重载，http://localhost:3000，文档 /docs） |
| `bun run db:generate` | 改表后生成迁移（随后必须 `bun run db:migrate`） |
| `bun test` | 运行测试 |
| `bun run typecheck && bun run lint` | 类型检查 + biome 检查 |
| `bun run build` | 打包单文件可执行到 bin/（内嵌前端页面与迁移，命名 app-{platform}-{arch}-{version}） |

## 关键约定（详见开发规范.md）

- `z` 一律从 `'@hono/zod-openapi'` 导入，禁止从 `'zod'` 导入
- app 一律 `createApp()` 构造，禁止 `new OpenAPIHono()`
- 业务错误唯一方式：`throw new AppError('XXX_NOT_FOUND')`；错误码在 `core/error-codes.ts` 追加
- handler 三步走：`c.req.valid()` → service → `ok()/created()`；禁止 try-catch
- repository 首参 `executor: DbExecutor`；service 不 import hono
- 日志用 `log()`（自动携带 traceId）；禁止 `console.*`
- 新模块 8 步流程见开发规范.md 第 4 节；表必须在 `src/db/schema.ts` 登记
- 集成测试的每个请求必须带 `content-type: application/json` 头

## 交付自检（每次改动后必须全绿）

```bash
bun run typecheck && bun run lint && bun test
```

禁止执行：`db:push`、手改 `src/db/migrations/`、`docker compose down -v`、修改依赖版本（除非用户明确要求）。
