import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { log } from '@/core/logger'
import { env } from '@/env'
import * as schema from './schema'

/**
 * 数据库连接唯一入口。
 * 业务代码 `import { db, type DbExecutor } from '@/db'`；
 * repository 首参统一用 DbExecutor（db 或事务 tx 皆可传入）。
 */
export const client = postgres(env.DATABASE_URL, {
  max: env.DB_POOL_MAX,
  // 预编译查询（postgres.js 特性，提升重复查询性能）
  prepare: true,
})

// LOG_LEVEL=debug/trace 时输出 SQL 日志（生产 info 级别自动静默）
const sqlLogger =
  env.LOG_LEVEL === 'debug' || env.LOG_LEVEL === 'trace'
    ? {
        logQuery(query: string, params: unknown[]) {
          log().debug({ query, params }, 'sql')
        },
      }
    : false

export const db = drizzle(client, {
  schema,
  casing: 'snake_case', // 须与 drizzle.config.ts 保持一致
  logger: sqlLogger,
})

export type Database = typeof db

/** repository 首参类型：普通连接或事务，两者 API 一致 */
export type DbExecutor = Database | Parameters<Parameters<Database['transaction']>[0]>[0]
