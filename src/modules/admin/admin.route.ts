import { createRoute, z } from '@hono/zod-openapi'
import { ApiResponseSchema, ErrorResponseSchema, jsonResponse, ok } from '@/core/response'
import type { App } from '@/core/types'
import { StatsDto, UserDto } from './admin.schema'
import { adminService } from './admin.service'

/**
 * admin 路由层 -- handler 只做三件事：c.req.valid() -> service -> ok()/204。
 * 禁止在 handler 写业务逻辑或 try-catch（错误由全局 error-handler 统一处理）。
 * 登录校验由模块级 requireAuth 统一承担（见 index.ts），路由不逐条声明 middleware。
 */

const listUsersRoute = createRoute({
  method: 'get',
  path: '/users',
  tags: ['admin'],
  summary: '用户列表（不含密码/secret）',
  responses: {
    200: jsonResponse(ApiResponseSchema(z.array(UserDto)), '成功'),
    401: jsonResponse(ErrorResponseSchema, '未登录'),
  },
})

const resetUserMfaRoute = createRoute({
  method: 'post',
  path: '/users/{username}/reset-mfa',
  tags: ['admin'],
  summary: '重置用户 MFA（清绑定，用户需重新绑定）',
  request: { params: z.object({ username: z.string().min(1).max(64) }) },
  responses: {
    204: { description: '已重置' },
    401: jsonResponse(ErrorResponseSchema, '未登录'),
    404: jsonResponse(ErrorResponseSchema, '用户不存在'),
  },
})

const statsRoute = createRoute({
  method: 'get',
  path: '/stats',
  tags: ['admin'],
  summary: '运行看板统计（活跃会话/在线用户/token/历史/关闭原因分布）',
  responses: {
    200: jsonResponse(ApiResponseSchema(StatsDto), '成功'),
    401: jsonResponse(ErrorResponseSchema, '未登录'),
  },
})

export function registerAdminRoutes(app: App): void {
  app.openapi(listUsersRoute, async (c) => {
    return ok(c, await adminService.listUsers())
  })

  app.openapi(resetUserMfaRoute, async (c) => {
    await adminService.resetUserMfa(c.req.valid('param').username)
    return c.body(null, 204)
  })

  app.openapi(statsRoute, async (c) => {
    return ok(c, await adminService.getStats())
  })
}
