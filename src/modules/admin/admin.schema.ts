import { z } from '@hono/zod-openapi'
import { StatsDto } from '@/modules/agent/agent.schema'

/**
 * admin 模块的 zod DTO -- 请求校验、TS 类型、OpenAPI 文档的唯一真源。
 * 注意：z 一律从 '@hono/zod-openapi' 导入（带 .openapi() 扩展），禁止从 'zod' 导入。
 * 看板统计的 StatsDto 由 agent 模块定义（数据源头），此处复用不重复声明。
 */
export { StatsDto }

/** 用户档案（管理列表；不含密码/MFA secret） */
export const UserDto = z
  .object({
    username: z.string(),
    mfaBoundAt: z.iso.datetime().nullable(),
    lastLoginAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
  })
  .openapi('AdminUser')
