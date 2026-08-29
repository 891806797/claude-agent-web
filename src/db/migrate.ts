import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { getLogger } from '@/core/logger'
import { env } from '@/env'
import { db } from './index'

/**
 * 运行时迁移（drizzle-orm migrator，非 drizzle-kit CLI）。
 * 目录解析优先级：显式 MIGRATIONS_DIR > 编译版嵌入目录（打包时 --asset 嵌入，
 * 挂载于 bunfs 的 migrations/）> 开发默认 ./src/db/migrations。
 * 开发环境常规走 `bun run db:migrate`（drizzle-kit）。
 */
export async function runMigrations(): Promise<void> {
  const logger = getLogger('migrate')
  const migrationsFolder = env.MIGRATIONS_DIR ?? defaultMigrationsFolder()
  logger.info({ migrationsFolder }, '开始执行数据库迁移')
  await migrate(db, { migrationsFolder })
  logger.info('数据库迁移完成')
}

/** 编译版读 bunfs 嵌入目录（--asset 按目录 basename 挂载）；开发读源码目录 */
function defaultMigrationsFolder(): string {
  return Bun.isStandaloneExecutable ? `${import.meta.dir}/migrations` : './src/db/migrations'
}
