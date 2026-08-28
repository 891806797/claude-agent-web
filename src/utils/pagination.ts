import { z } from '@hono/zod-openapi'

/**
 * 分页查询标准参数：query 参数（字符串）经 z.coerce 转数字。
 * 所有列表接口的 query 必须基于此 schema extend。
 */
export const PageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1).openapi({ example: 1 }),
  pageSize: z.coerce.number().int().min(1).max(100).default(20).openapi({ example: 20 }),
})

/** output 类型：default 已填充，page/pageSize 恒为 number */
export type PageQuery = z.output<typeof PageQuerySchema>

export const getOffset = (q: PageQuery): number => (q.page - 1) * q.pageSize
