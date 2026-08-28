import { getLogger } from '@/core/logger'
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

  const server = Bun.serve({
    port: env.PORT,
    fetch: app.fetch,
    idleTimeout: 30,
  })

  logger.info({ port: server.port, env: env.NODE_ENV, logBody: env.LOG_BODY }, '服务已启动')

  // 优雅停机：停止接收新连接 -> 关闭数据库连接池
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      logger.info({ signal }, '正在关闭服务')
      server.stop(true)
      void client.end({ timeout: 5 }).then(() => process.exit(0))
    })
  }
}

void main()
