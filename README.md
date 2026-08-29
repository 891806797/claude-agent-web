# claude-agent-web

Bun + Hono + Drizzle ORM + PostgreSQL 后端模板，为 **Claude Code 等 AI 辅助开发**而设计：
以「强约定 + 固定范式」约束 AI 产出一致、可控的代码。

> 开发前必读 [开发规范.md](./开发规范.md)；`src/modules/article/` 是所有业务模块的标准范式（活教材）。

## 技术栈

| 关注点 | 选型 |
|---|---|
| 运行时 / 包管理 / 测试 | bun（`bun test`） |
| Web 框架 | hono + @hono/zod-openapi（OpenAPI 3.1） |
| 校验 / 类型 / 文档 | zod v4（一份 schema = 运行时校验 + TS 类型 + API 文档） |
| ORM / 迁移 | drizzle-orm + drizzle-kit（postgres.js 驱动） |
| 日志 | pino（结构化 JSON，dev 彩色 pretty） |
| Lint / Format | biome |
| 文档 UI | Scalar（`/docs`） |

## 快速开始

```bash
bun install                 # 安装依赖

# 数据库（二选一）
bun run docker:db           # 方式一：docker-compose 起独立 postgres:17
# 方式二：使用已有 PG —— 修改 .env 的 DATABASE_URL 即可，并在其中创建一个空库

bun run db:migrate          # 执行数据库迁移
bun run dev                 # 启动开发服务（热重载）-> http://localhost:3000
```

- API 文档：http://localhost:3000/docs（Scalar，可直接调试）
- OpenAPI JSON：http://localhost:3000/openapi.json
- 健康检查：`/healthz`（存活）、`/readyz`（数据库就绪）

## 常用命令

| 命令 | 说明 |
|---|---|
| `bun run dev` | 开发模式（--hot 热重载） |
| `bun run build` | 打包为独立可执行文件（见下方「打包部署」） |
| `bun test` / `bun run test:watch` | 运行测试 |
| `bun run typecheck` | TS 类型检查 |
| `bun run lint` / `lint:fix` | biome 检查 / 自动修复 |
| `bun run db:generate` | 表结构变更后生成迁移文件 |
| `bun run db:migrate` | 执行迁移（内部 `bunx drizzle-kit`，自动读 .env） |
| `bun run db:studio` | 打开 drizzle studio 数据浏览器 |

## 目录结构

```
src/
├── index.ts       # 进程入口：启动迁移(可选) + Bun.serve + 优雅停机
├── app.ts         # 应用组装：中间件 -> 路由 -> onError/notFound（不监听端口，可测）
├── env.ts         # 环境变量 zod 校验，导出类型安全的 env（配置唯一来源）
├── core/          # 框架地基（默认禁止修改）：错误码/AppError/响应工厂/日志/createApp/中间件
├── db/            # 数据库客户端、迁移运行器、schema 汇总
├── modules/       # 业务模块区（开发主战场）：article 为标准范式
├── routes/        # 路由总表：healthz/readyz + 模块挂载 + /docs
└── utils/         # 跨模块纯函数工具（分页等）
```

## 请求处理链路

```
Bun.serve
  └─ requestContext   traceId 生成/透传 + child logger（AsyncLocalStorage）
  └─ accessLog        每请求一条汇总日志（method/path/status/durationMs/ip/ua）
  └─ [cors]           CORS_ORIGIN 配置时启用
  └─ routes           route handler：c.req.valid() -> service -> ok()
       └─ service     业务逻辑；错误只 throw AppError；不依赖 hono
            └─ repository  drizzle 查询；首参 DbExecutor（db/tx 通用）
                 └─ postgres
  └─ onError          AppError -> 注册表查 status；未知 -> 500（日志留全量）
  └─ notFound         未匹配路由统一 404
```

统一响应：成功 `{ "data": ... }`；失败 `{ "error": { "code", "message", "traceId" } }`；
分页 `{ "data": { "list", "total", "page", "pageSize" } }`。

## 日志与问题排查

**traceId 三处一致**：每条日志字段、响应头 `x-request-id`、错误响应体 `error.traceId`。
拿到一个 traceId 即可在日志中还原该请求的完整链路（访问日志 + SQL + 业务日志 + 错误堆栈）。

| 手段 | 开启方式 |
|---|---|
| SQL 日志（query + params） | `LOG_LEVEL=debug` |
| 请求体日志（截断 2KB，敏感字段脱敏） | `LOG_BODY=true` |
| dev 彩色单行日志 | `NODE_ENV=development`（默认） |
| 生产 JSON 日志 | `NODE_ENV=production` |

## 打包部署

```bash
bun run build
# 产物：bin/app-{platform}-{arch}-{version}.exe（Windows）—— 唯一产物，单文件
# 内嵌 bun 运行时 + 前端页面 + 数据库迁移，约 100MB
# 交叉编译：bun run build -- --target=bun-linux-x64（支持 bun-{windows|linux|darwin}-{x64|arm64}）
```

部署只需把这一个可执行文件拷到目标机器，配置环境变量后直接运行：

```powershell
$env:DATABASE_URL = 'postgres://user:pass@host:5432/dbname'
.\app-windows-x64-0.1.0.exe
```

Linux/macOS：`DATABASE_URL=... ./app-linux-x64-0.1.0`（版本号取自 package.json）

- 编译版**默认启动即迁移**（嵌入的 migrations 自动建表/升级，幂等可重复启动）；关闭设 `MIGRATE_ON_START=false`，换外部迁移目录设 `MIGRATIONS_DIR=./migrations`
- 也会自动读取运行目录下的 `.env`
- 可执行文件同时服务前端页面与 API：`/` 为前端入口，`/api/*`、`/docs` 为后端接口

## 常见问题

- **Windows 终端 curl 中文乱码**：Git Bash 的 curl 以本地编码发送 body，属客户端问题；
  用 `--data-binary @file.json`（UTF-8 文件）或代码内 fetch 验证。
- **5432 端口被占**：本机已有 postgres 时改 docker-compose 端口映射（如 `5433:5432`）
  并同步 `.env` 的 DATABASE_URL；或直接使用已有实例。
- **bun --hot 后连接异常**：热重载旧实例的连接池可能残留，重启 dev 即可。
- **新增了表但 db:generate 无反应**：确认已在 `src/db/schema.ts` 登记 `export * from ...table`。
