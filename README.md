# claude-agent-web

**Web 版 Claude Code**：多人共用的 AI 编码智能体平台。基于 `@anthropic-ai/claude-agent-sdk`
驱动 CLI 子进程，Bun + Hono + Drizzle + PostgreSQL 后端，React 聊天前端，可编译为单文件可执行部署。

> 开发前必读 [开发规范.md](./开发规范.md)：强约定 + 固定范式，`src/modules/auth/` 是业务模块标准范式（活教材），
> `src/modules/agent/` 是复杂模块（SSE/注册表/子进程）进阶参考。

## 功能特性

- **AI 编码会话**：SSE 流式输出、工具调用特化渲染（Bash/文件树/搜索结果…）、工具审批
  （可修改参数/总是放行）、中断、checkpoint 文件回滚、子代理、图片输入、斜杠命令与 @ 提及
- **多用户隔离**：JWT(cookie) + MFA-TOTP 登录；每用户独立 `CLAUDE_CONFIG_DIR`，会话注册表
  按目录做属主校验与配额（每用户/全局上限、空闲回收、绝对寿命、evict 接管）
- **智能体（persona）**：可复用人格定义（追加系统提示词注入）；会话空闲时热切换
  （进程替换 + 同 sid resume，历史与记忆保留）；绑定快照落库，定义事后修改不影响旧会话
- **管理端**：用户管理（重置 MFA）、运行看板（活跃会话/token 用量/关闭原因分布）、
  智能体定义维护、系统设置
- **工程化**：OpenAPI 3.1 文档（Scalar 可调试）、结构化日志 traceId 全链路、
  启动即迁移、单文件编译产物、BASE_URL 子路径部署

## 技术栈

| 关注点 | 选型 |
|---|---|
| 运行时 / 包管理 / 测试 | bun（`bun test`） |
| 后端框架 | hono + @hono/zod-openapi（OpenAPI 3.1） |
| AI 能力 | @anthropic-ai/claude-agent-sdk（spawn CLI 子进程，streaming-input 常驻） |
| 校验 / 类型 / 文档 | zod v4（一份 schema = 运行时校验 + TS 类型 + API 文档）+ Scalar |
| ORM / 迁移 | drizzle-orm + drizzle-kit（postgres.js 驱动） |
| 前端 | Vite + React 19 + Tailwind v4 + zustand + shadcn 范式组件 + sonner |
| 日志 | pino（结构化 JSON，dev 彩色 pretty） |
| Lint / Format | biome（后端）/ prettier（ui/） |

## 快速开始

```bash
# 0) 前置：Node/Bun 已装；.env 至少需要 DATABASE_URL、AUTH_JWT_SECRET、
#    以及 Anthropic 网关三件套（ANTHROPIC_BASE_URL/AUTH_TOKEN/MODEL，见 .env.example）

bun install                 # 后端依赖

# 1) 数据库（二选一）
bun run docker:db           # 方式一：docker-compose 起独立 postgres:17
# 方式二：已有 PG —— 改 .env 的 DATABASE_URL 指向一个空库

bun run db:migrate          # 执行数据库迁移
bun run dev                 # 启动后端（热重载）-> http://localhost:3000

# 2) 前端（另开终端）
cd ui && bun install && bun run dev    # -> http://localhost:5173（proxy 转 3000）
```

- API 文档：http://localhost:3000/docs（Scalar，可直接调试）
- OpenAPI JSON：http://localhost:3000/openapi.json
- 健康检查：`/healthz`（存活）、`/readyz`（数据库就绪）
- 全部环境变量说明见 `.env.example`（数据库/日志/CORS/认证/agent 会话治理/网关）

## 常用命令

| 命令 | 说明 |
|---|---|
| `bun run dev` | 后端开发模式（--hot 热重载）；前端 `cd ui && bun run dev` |
| `bun run build` | 打包单文件可执行到 bin/（见「打包部署」） |
| `bun test` / `bun run test:watch` | 运行测试 |
| `bun run typecheck` | TS 类型检查 |
| `bun run lint` / `lint:fix` | biome 检查 / 自动修复（只管后端；ui 用 prettier） |
| `bun run db:generate` | 表结构变更后生成迁移文件 |
| `bun run db:migrate` | 执行迁移（内部 `bunx drizzle-kit`，自动读 .env） |
| `bun run db:studio` | 打开 drizzle studio 数据浏览器 |

## 目录结构

```
├── src/
│   ├── index.ts       # 进程入口：启动迁移(可选) + Bun.serve + 优雅停机
│   ├── app.ts         # 应用组装：中间件 -> 路由 -> onError/notFound（不监听端口，可测）
│   ├── env.ts         # 环境变量 zod 校验，导出类型安全的 env（配置唯一来源）
│   ├── core/          # 框架地基（默认禁止修改）：错误码/AppError/响应工厂/日志/中间件
│   ├── db/            # 数据库客户端、迁移运行器、schema 汇总
│   ├── modules/       # 业务模块区（开发主战场）
│   │   ├── auth/      # 登录/JWT/MFA-TOTP/SOAP 外部认证/失败锁定（标准范式）
│   │   ├── agent/     # AI 会话核心：项目/会话/审批/SSE/persona + SDK 集成层
│   │   └── admin/     # 管理端门面（跨模块聚合查询）
│   ├── routes/        # 路由总表：healthz/readyz + 模块挂载 + /docs
│   └── utils/         # 跨模块纯函数工具（分页等）
├── ui/                # React 前端（pages/components/hooks/stores/lib，详见开发规范第 13 节）
├── scripts/build-exe.ts  # 编译打包编排
└── src/db/migrations/    # drizzle-kit 生成的迁移（禁止手改）
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

会话操作特殊协议：POST/DELETE 类携带 header `x-session-id` + `x-workspace-dir`(base64url)；
SSE 端点走 query 参数（EventSource 不支持自定义 header）。

## 日志与问题排查

**traceId 三处一致**：每条日志字段、响应头 `x-request-id`、错误响应体 `error.traceId`。
拿到一个 traceId 即可在 `logs/`（按日滚动，保留期 LOG_RETENTION_DAYS）还原该请求完整链路。

| 手段 | 开启方式 |
|---|---|
| SQL 日志（query + params） | `LOG_LEVEL=debug` |
| 请求体日志（截断 2KB，敏感字段脱敏） | `LOG_BODY=true` |
| dev 彩色单行日志 | `NODE_ENV=development`（默认） |
| 生产 JSON 日志 | `NODE_ENV=production` |

## 打包部署

```bash
bun run build
# 产物：bin/app-{platform}-{arch}-{version}[.exe] —— 唯一产物，单文件（约 300MB）
# 内嵌 bun 运行时 + 前端页面 + 数据库迁移
# 交叉编译：bun run build -- --target=bun-linux-x64（支持 bun-{windows|linux|darwin}-{x64|arm64}）
#   注意：bun install 按本机 OS 只装本机平台的 CLI 包，交叉编译前需手工补装目标平台包：
#   bun add @anthropic-ai/claude-agent-sdk-linux-x64@0.3.250   # 版本对齐 dependencies 中的 SDK
#   （仅构建期解析需要，构建完可还原 package.json / bun.lock）
#   musl / darwin-x64 / arm64 变体不内嵌 CLI：产物需目标机设置 AGENT_CLI_PATH 指向自备 claude 二进制
```

部署只需把这一个可执行文件拷到目标机器，配置环境变量后直接运行：

```powershell
$env:DATABASE_URL = 'postgres://user:pass@host:5432/dbname'
.\app-windows-x64-0.1.0.exe
```

Linux/macOS：`DATABASE_URL=... ./app-linux-x64-0.1.0`（版本号取自 package.json）

- 编译版**默认启动即迁移**（嵌入的 migrations 自动建表/升级，幂等可重复启动）；关闭设
  `MIGRATE_ON_START=false`，换外部迁移目录设 `MIGRATIONS_DIR=./migrations`
- 也会自动读取运行目录下的 `.env`（与可执行文件同目录放置即可）
- 可执行文件同时服务前端页面与 API：`/` 为前端入口，`/api/*`、`/docs` 为后端接口
- **子路径部署**（nginx 反代场景）：`.env` 设 `BASE_URL=/claude`（一处配置全链生效）；
  构建 exe 时须设相同值（驱动前端产物路径），启动时同理

## 常见问题

- **Windows 终端 curl 中文乱码**：Git Bash 的 curl 以本地编码发送 body，属客户端问题；
  用 `--data-binary @file.json`（UTF-8 文件）或代码内 fetch 验证。
- **5432 端口被占**：本机已有 postgres 时改 docker-compose 端口映射（如 `5433:5432`）
  并同步 `.env` 的 DATABASE_URL；或直接使用已有实例。
- **bun --hot 后连接异常**：热重载旧实例的连接池可能残留，重启 dev 即可。
- **改后端代码后 AI 会话报「会话不存在」**：dev 热重载会中断活跃 CLI 子进程（属预期），
  刷新页面即走恢复链路；生产编译版无此现象。
- **新增了表但 db:generate 无反应**：确认已在 `src/db/schema.ts` 登记 `export * from ...table`。
- **agent 调用 LLM 报错**：检查 `.env` 的 Anthropic 网关三件套是否填写正确。
