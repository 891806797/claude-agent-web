import { cleanupOldLogFiles, getLogger } from '@/core/logger'
import { client } from '@/db'
import { runMigrations } from '@/db/migrate'
import { env } from '@/env'
import { app } from './app'

const logger = getLogger('server')

async function main() {
  // 启动即迁移：显式 MIGRATE_ON_START 优先；未设置时编译版默认开（单文件部署即用），dev 默认关
  if (env.MIGRATE_ON_START ?? Bun.isStandaloneExecutable) {
    await runMigrations()
  }

  // 清理过期日志文件（按 LOG_RETENTION_DAYS）
  cleanupOldLogFiles()

  // 生产环境使用默认 JWT 密钥时强提醒（不阻断启动）
  if (env.NODE_ENV === 'production' && env.AUTH_JWT_SECRET.includes('change-me')) {
    logger.warn('AUTH_JWT_SECRET 为默认值，生产环境必须更换！')
  }

  // 启动清扫：终止上次崩溃遗留的 claude.exe 孤儿进程（见 agent/session-registry）
  const { startupOrphanSweep } = await import('@/modules/agent/session-registry')
  await startupOrphanSweep()

  const server = Bun.serve({
    port: env.PORT,
    fetch: app.fetch,
    idleTimeout: 30,
  })

  logger.info({ port: server.port, env: env.NODE_ENV, logBody: env.LOG_BODY }, '服务已启动')

  // 优雅停机：关闭全部 agent 会话 -> 停止接收新连接 -> 关闭数据库连接池
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      logger.info({ signal }, '正在关闭服务')
      void (async () => {
        try {
          const { closeAllAgentSessions } = await import('@/modules/agent/session-registry')
          await closeAllAgentSessions('shutdown')
        } finally {
          server.stop(true)
          await client.end({ timeout: 5 }).then(() => process.exit(0))
        }
      })()
    })
  }
}

void main()
