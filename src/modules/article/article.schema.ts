import { z } from '@hono/zod-openapi'
import type { ArticleRow } from './article.table'

/**
 * article 模块的 zod DTO —— 请求校验、TS 类型、OpenAPI 文档的唯一真源。
 * 注意：z 一律从 '@hono/zod-openapi' 导入（带 .openapi() 扩展），禁止从 'zod' 导入。
 */

export const ArticleIdParam = z.object({
  id: z
    .string()
    .uuid()
    .openapi({ param: { name: 'id', in: 'path' } }),
})

export const CreateArticleInput = z.object({
  title: z.string().min(1).max(200).openapi({ example: '第一篇文章' }),
  content: z.string().max(50000).default('').openapi({ example: '正文内容' }),
})

/**
 * 更新输入必须显式声明 optional 字段，禁止基于 Create 的 .partial() 派生：
 * Create 中带 .default() 的字段在部分更新时会被默认值填充，导致未提交字段被意外清空。
 */
export const UpdateArticleInput = z.object({
  title: z.string().min(1).max(200).optional().openapi({ example: '新标题' }),
  content: z.string().max(50000).optional().openapi({ example: '新内容' }),
})

/** 对外输出 DTO；注册为 #/components/schemas/Article */
export const ArticleDto = z
  .object({
    id: z.string().uuid(),
    title: z.string(),
    content: z.string(),
    status: z.enum(['draft', 'published']),
    createdAt: z.iso.datetime(), // zod v4 语法（取代 z.string().datetime()）
    updatedAt: z.iso.datetime(),
  })
  .openapi('Article')

export type Article = z.infer<typeof ArticleDto>
export type CreateArticleData = z.infer<typeof CreateArticleInput>
export type UpdateArticleData = z.infer<typeof UpdateArticleInput>

/** Row -> DTO 映射：Date 统一转 ISO 字符串，数据库细节不外泄 */
export const toArticle = (row: ArticleRow): Article => ({
  ...row,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
})
