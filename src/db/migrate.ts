import { join } from 'node:path'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { getLogger } from '@/core/logger'
import { env } from '@/env'
import { db } from './index'

/**
 * 运行时迁移（drizzle-orm migrator，非 drizzle-kit CLI）。
 * 目录解析优先级：显式 MIGRATIONS_DIR > 编译版嵌入目录（打包时 --asset 嵌入，
 * 挂载于 bunfs 的 migrations/）> 开发默认 ./src/db/migrations。
 * 开发环境常规走 `bun run db:migrate`（drizzle-kit）。
 *
 * migrationsSchema='public'：迁移记录表 __drizzle_migrations 与业务表同放 public，
 * 不再单独创建 drizzle 模式（迁移器默认行为）。须与 drizzle.config.ts 的
 * migrations.schema 保持一致，否则两条迁移路径记录互相看不见、重复重放。
 */
export async function runMigrations(): Promise<void> {
  const logger = getLogger('migrate')
  const migrationsFolder = env.MIGRATIONS_DIR ?? defaultMigrationsFolder()
  logger.info({ migrationsFolder }, '开始执行数据库迁移')
  await migrate(db, { migrationsFolder, migrationsSchema: 'public' })
  logger.info('数据库迁移完成')
}

/** 编译版读 bunfs 嵌入目录（--asset 按目录 basename 挂载）；开发读源码目录 */
function defaultMigrationsFolder(): string {
  return Bun.isStandaloneExecutable ? join(import.meta.dir, 'migrations') : './src/db/migrations'
}
