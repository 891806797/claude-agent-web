import { z } from '@hono/zod-openapi'

/**
 * 环境变量唯一来源：进程启动即校验，失败直接退出。
 * 业务代码一律 `import { env } from '@/env'`，禁止直接读 Bun.env / process.env。
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  /** 业务表所在 schema（公司统一库下各产品的独立 schema；不可为 public）。
   *  与 src/db/app-schema.ts 共用 process.env.DB_SCHEMA，
   *  须与 .env 保持一致——generate 时读到的值会字面写入迁移 SQL。 */
  DB_SCHEMA: z
    .string()
    .min(1)
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, '须为合法 PG 标识符：字母/下划线开头，仅含字母数字下划线')
    .refine((v) => v !== 'public', '不可用 public（public 为公共区，业务表应独立 schema）')
    .default('claude_agent_web'),
  /** 迁移记录表 __drizzle_migrations 所在 schema（默认 public）。
   *  public 一定存在，migrator 首次 ensure 记录表最稳；
   *  若设为业务 schema，该 schema 必须在首次迁移前已存在（DBA 预创建），
   *  否则 migrator 建记录表时 schema 不存在会失败——CREATE SCHEMA 在迁移 SQL 里，
   *  时机晚于 ensure 记录表。须与 drizzle.config.ts 的 migrations.schema 保持一致。 */
  MIGRATIONS_SCHEMA: z
    .string()
    .min(1)
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, '须为合法 PG 标识符：字母/下划线开头，仅含字母数字下划线')
    .default('public'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  LOG_BODY: z.stringbool().default(false),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  CORS_ORIGIN: z
    .string()
    .optional()
    .transform((v) => (v ? v.trim() : undefined)),
  MIGRATE_ON_START: z.stringbool().optional(),
  MIGRATIONS_DIR: z.string().optional(),

  /** 子路径部署前缀（nginx 反代场景，如 /claude）；同时驱动前端构建 base。
   *  空或 '/' = 根路径部署（默认）。仅允许 / 开头的子路径，禁止携带协议/主机名。 */
  BASE_URL: z
    .string()
    .optional()
    .transform((v) => {
      const s = v?.trim()
      if (!s || s === '/') return ''
      return s.replace(/\/+$/, '') // 容忍尾斜杠：'/claude/' -> '/claude'
    })
    .refine((v) => v === '' || /^\/[A-Za-z0-9\-_.]+(\/[A-Za-z0-9\-_.]+)*$/.test(v), {
      message: 'BASE_URL 必须是以 / 开头的子路径（如 /claude），不能含协议、主机名或尾斜杠',
    }),

  // ---- 认证（对齐 claude-agent-desktop 的 OA Web Service 体系）----
  /** OA 登录 Web Service 地址（可为 WSDL 地址，自动去掉 ?wsdl 得到 POST endpoint）。
   *  内网地址不入库不入代码，仅经 .env 配置；未配置时登录不可用（502 登录服务暂不可用） */
  AUTH_WEB_SERVICE_URL: z.string().optional(),
  /** OA Web Service 的 targetNamespace（同上，仅 .env 配置） */
  AUTH_WEB_SERVICE_NS: z.string().optional(),
  /** JWT 签名密钥（生产必须更换默认值，启动时会告警） */
  AUTH_JWT_SECRET: z.string().min(16).default('claude-agent-web-dev-jwt-secret-change-me'),
  /** MFA secret 落库加密密钥（AES-256-GCM）；未设置时从 AUTH_JWT_SECRET 派生 */
  AUTH_MFA_ENC_KEY: z.string().min(16).optional(),
  /** TOTP 二维码 issuer */
  AUTH_MFA_ISSUER: z.string().default('AI编码智能体-Web'),
  /** 管理员白名单（逗号分隔用户名）：登录成功时自动提升为 admin 并落库（仅提升不降级） */
  AUTH_ADMIN_USERS: z
    .string()
    .optional()
    .transform((v) =>
      v
        ? v
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : [],
    ),
  /** 登录限流：窗口（分钟）与窗口内最大失败次数 */
  AUTH_LOGIN_WINDOW_MINUTES: z.coerce.number().int().min(1).default(15),
  AUTH_LOGIN_MAX_FAILURES: z.coerce.number().int().min(1).default(5),

  // ---- agent 会话治理 ----
  /** 每用户 CLAUDE_CONFIG_DIR 根（按用户名隔离会话转录与设置） */
  AGENT_CONFIG_ROOT: z.string().default('./data/claude-configs'),
  /** （可选）限制项目目录必须位于此根之下 */
  AGENT_WORKSPACE_ROOT: z.string().optional(),
  /** 无活动（且 idle）的空闲回收时长（分钟） */
  AGENT_SESSION_IDLE_MINUTES: z.coerce.number().int().min(1).default(5),
  /** 会话绝对寿命兜底（小时） */
  AGENT_SESSION_MAX_LIFE_HOURS: z.coerce.number().int().min(1).default(6),
  /** 每用户活跃会话上限 */
  AGENT_MAX_SESSIONS_PER_USER: z.coerce.number().int().min(1).default(3),
  /** 全局活跃会话上限 */
  AGENT_MAX_TOTAL_SESSIONS: z.coerce.number().int().min(1).default(24),
  /** （可选）显式指定 SDK CLI 二进制路径（编译版部署到未内嵌二进制的平台时使用） */
  AGENT_CLI_PATH: z.string().optional(),

  // ---- 日志文件 ----
  /** 按天滚动日志目录（文件名 console-YYYY-MM-DD.log） */
  LOG_DIR: z.string().default('./logs'),
  /** 日志保留天数（启动时清理过期文件） */
  LOG_RETENTION_DAYS: z.coerce.number().int().min(1).default(14),

  // ---- Anthropic 网关（透传给 SDK 子进程 env）----
  ANTHROPIC_BASE_URL: z.string().optional(),
  ANTHROPIC_AUTH_TOKEN: z.string().optional(),
  ANTHROPIC_MODEL: z.string().optional(),
})

const parsed = EnvSchema.safeParse(Bun.env)

if (!parsed.success) {
  // biome-ignore lint/suspicious/noConsole: 校验失败发生在 logger 初始化之前，console 是唯一输出通道（全项目唯一例外）
  console.error(`[env] 环境变量校验失败:\n${JSON.stringify(z.treeifyError(parsed.error), null, 2)}`)
  process.exit(1)
}

export const env = parsed.data
export const isDev = env.NODE_ENV === 'development'
export type Env = z.infer<typeof EnvSchema>
