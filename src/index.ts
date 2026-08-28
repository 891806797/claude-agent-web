import { getLogger } from '@/core/logger'
import { client } from '@/db'
import { runMigrations } from '@/db/migrate'
import { env } from '@/env'
import { app } from './app'

const logger = getLogger('server')

async function main() {
  // 编译版部署常用：启动即迁移（MIGRATE_ON_START=true MIGRATIONS_DIR=./migrations）
  if (env.MIGRATE_ON_START) {
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
