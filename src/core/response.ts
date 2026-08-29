import { z } from '@hono/zod-openapi'
import type { Context } from 'hono'
import type { AppEnv } from './types'

/**
 * 统一响应结构：
 *   成功  { data }                     （分页时 data = { list, total, page, pageSize }）
 *   失败  { error: { code, message, traceId, details? } }
 * 所有路由的 responses 必须用这里的 schema 工厂组装，禁止手写响应结构。
 */

// ---- schema 工厂（供 createRoute 的 responses 使用）----

export function ApiResponseSchema<T extends z.ZodType>(data: T) {
  return z.object({ data })
}

export const ErrorResponseSchema = z.object({
  error: z.object({
    code: z.string().openapi({ example: 'ARTICLE_NOT_FOUND' }),
    message: z.string().openapi({ example: '文章不存在' }),
    traceId: z.string().openapi({ example: 'V1StGXR8_Z5jdHi6B-myT' }).optional(),
    details: z.unknown().optional(),
  }),
})

export function PaginatedSchema<T extends z.ZodType>(item: T) {
  return z.object({
    list: z.array(item),
    total: z.number().int().openapi({ example: 100 }),
    page: z.number().int().openapi({ example: 1 }),
    pageSize: z.number().int().openapi({ example: 20 }),
  })
}

export interface Paginated<T> {
  list: T[]
  total: number
  page: number
  pageSize: number
}

/** createRoute 中 responses 的标准组装方式：`200: jsonResponse(ApiResponseSchema(ArticleDto), '成功')` */
export function jsonResponse<T extends z.ZodType>(schema: T, description: string) {
  return {
    description,
    content: { 'application/json': { schema } } as const,
  }
}

// ---- handler helper（供路由 handler 使用；内部使用字面量 status 保证类型推断）----

/** 200 响应：return ok(c, data) */
export function ok<T>(c: Context<AppEnv>, data: T) {
  return c.json({ data }, 200)
}

/** 201 响应（创建成功）：return created(c, data) */
export function created<T>(c: Context<AppEnv>, data: T) {
  return c.json({ data }, 201)
}
