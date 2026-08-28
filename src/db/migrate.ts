import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { getLogger } from '@/core/logger'
import { env } from '@/env'
import { db } from './index'

/**
 * 运行时迁移（drizzle-orm migrator，非 drizzle-kit CLI）。
 * 使用场景：编译版可执行文件部署时设置 MIGRATE_ON_START=true + MIGRATIONS_DIR=./migrations，
 * 启动即自动迁移；开发环境常规走 `bun run db:migrate`（drizzle-kit）。
 */
export async function runMigrations(): Promise<void> {
  const logger = getLogger('migrate')
  logger.info({ migrationsDir: env.MIGRATIONS_DIR }, '开始执行数据库迁移')
  await migrate(db, { migrationsFolder: env.MIGRATIONS_DIR })
  logger.info('数据库迁移完成')
}
