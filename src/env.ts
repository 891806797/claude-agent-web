import { z } from '@hono/zod-openapi'

/**
 * 环境变量唯一来源：进程启动即校验，失败直接退出。
 * 业务代码一律 `import { env } from '@/env'`，禁止直接读 Bun.env / process.env。
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  LOG_BODY: z.stringbool().default(false),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  CORS_ORIGIN: z
    .string()
    .optional()
    .transform((v) => (v ? v.trim() : undefined)),
  MIGRATE_ON_START: z.stringbool().optional(),
  MIGRATIONS_DIR: z.string().optional(),
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
