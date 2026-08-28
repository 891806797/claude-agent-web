import { createRoute, z } from '@hono/zod-openapi'
import {
  ApiResponseSchema,
  created,
  ErrorResponseSchema,
  jsonResponse,
  ok,
  PaginatedSchema,
} from '@/core/response'
import type { App } from '@/core/types'
import { PageQuerySchema } from '@/utils/pagination'
import {
  ArticleDto,
  ArticleIdParam,
  CreateArticleInput,
  UpdateArticleInput,
} from './article.schema'
import { articleService } from './article.service'

/**
 * article 路由层 —— handler 只做三件事：c.req.valid() -> service -> ok/created。
 * 禁止在 handler 写业务逻辑或 try-catch（错误由全局 error-handler 统一处理）。
 * 注意：POST/PUT 的 body 必须声明 required: true，且客户端必须带 Content-Type: application/json。
 */

const listRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['article'],
  summary: '分页查询文章',
  request: {
    query: PageQuerySchema.extend({
      status: z.enum(['draft', 'published']).optional().openapi({ example: 'draft' }),
    }),
  },
  responses: {
    200: jsonResponse(ApiResponseSchema(PaginatedSchema(ArticleDto)), '成功'),
    422: jsonResponse(ErrorResponseSchema, '参数错误'),
  },
})

const getByIdRoute = createRoute({
  method: 'get',
  path: '/{id}',
  tags: ['article'],
  summary: '查询文章详情',
  request: { params: ArticleIdParam },
  responses: {
    200: jsonResponse(ApiResponseSchema(ArticleDto), '成功'),
    404: jsonResponse(ErrorResponseSchema, '文章不存在'),
  },
})

const createArticleRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['article'],
  summary: '创建文章',
  request: {
    body: { required: true, content: { 'application/json': { schema: CreateArticleInput } } },
  },
  responses: {
    201: jsonResponse(ApiResponseSchema(ArticleDto), '已创建'),
    422: jsonResponse(ErrorResponseSchema, '参数错误'),
  },
})

const updateRoute = createRoute({
  method: 'put',
  path: '/{id}',
  tags: ['article'],
  summary: '更新文章',
  request: {
    params: ArticleIdParam,
    body: { required: true, content: { 'application/json': { schema: UpdateArticleInput } } },
  },
  responses: {
    200: jsonResponse(ApiResponseSchema(ArticleDto), '成功'),
    404: jsonResponse(ErrorResponseSchema, '文章不存在'),
    422: jsonResponse(ErrorResponseSchema, '参数错误'),
  },
})

const removeRoute = createRoute({
  method: 'delete',
  path: '/{id}',
  tags: ['article'],
  summary: '删除文章',
  request: { params: ArticleIdParam },
  responses: {
    204: { description: '已删除' },
    404: jsonResponse(ErrorResponseSchema, '文章不存在'),
  },
})

export function registerArticleRoutes(app: App): void {
  app.openapi(listRoute, async (c) => {
    const { page, pageSize, status } = c.req.valid('query')
    return ok(c, await articleService.list({ page, pageSize, status }))
  })

  app.openapi(getByIdRoute, async (c) => {
    return ok(c, await articleService.getById(c.req.valid('param').id))
  })

  app.openapi(createArticleRoute, async (c) => {
    return created(c, await articleService.create(c.req.valid('json')))
  })

  app.openapi(updateRoute, async (c) => {
    const { id } = c.req.valid('param')
    return ok(c, await articleService.update(id, c.req.valid('json')))
  })

  app.openapi(removeRoute, async (c) => {
    await articleService.remove(c.req.valid('param').id)
    return c.body(null, 204)
  })
}
