/**
 * drizzle 表定义汇总 —— drizzle-kit 的扫描入口（见 drizzle.config.ts 的 schema 字段）。
 * 新增模块后必须在此登记：`export * from '@/modules/xxx/xxx.table'`
 *
 * 业务表所在 schema 由 src/db/app-schema.ts 的 pgSchema 限定（各 .table.ts 直接 import）；
 * pgSchema 实例无需在此 re-export——运行时 drizzle 经表对象即可定位 schema。
 */

export * from '@/modules/agent/agent.table'
export * from '@/modules/auth/auth.table'
