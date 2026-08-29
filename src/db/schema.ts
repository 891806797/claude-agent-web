/**
 * drizzle 表定义汇总 —— drizzle-kit 的扫描入口（见 drizzle.config.ts 的 schema 字段）。
 * 新增模块后必须在此登记：`export * from '@/modules/xxx/xxx.table'`
 */

export * from '@/modules/agent/agent.table'
export * from '@/modules/auth/auth.table'
