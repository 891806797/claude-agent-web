import { createRoute, z } from '@hono/zod-openapi'
import type { Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { getLogger } from '@/core/logger'
import { AUTH_COOKIE, requireAuth } from '@/core/middleware/auth'
import { ApiResponseSchema, ErrorResponseSchema, jsonResponse, ok } from '@/core/response'
import type { App, AppEnv } from '@/core/types'
import {
  LoginInput,
  LoginResultDto,
  MeDto,
  MfaSetupInput,
  MfaSetupResultDto,
  MfaStatusDto,
  MfaTokenInput,
  MfaUnbindInput,
} from './auth.schema'
import { authService } from './auth.service'
import { revokeToken, roleFromToken, signToken } from './jwt'

/**
 * auth 路由层 -- handler 只做三件事：c.req.valid() -> service -> ok()。
 * 禁止在 handler 写业务逻辑或 try-catch（错误由全局 error-handler 统一处理）。
 * 注意：POST 的 body 必须声明 required: true，且客户端必须带 Content-Type: application/json。
 */

const logger = getLogger('auth')

/** JWT cookie（7 天，HttpOnly + SameSite=Lax 防 CSRF 跨站 POST） */
const COOKIE_MAX_AGE = 7 * 24 * 60 * 60

function setAuthCookie(c: Context<AppEnv>, token: string) {
  setCookie(c, AUTH_COOKIE, token, {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: COOKIE_MAX_AGE,
  })
}

/** 客户端 IP（无代理直连场景即对端地址） */
function clientIp(c: Context<AppEnv>): string {
  return c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
}

const loginRoute = createRoute({
  method: 'post',
  path: '/login',
  tags: ['auth'],
  summary: '登录第一步：账号密码（SOAP 验密 + 限流）',
  request: {
    body: { required: true, content: { 'application/json': { schema: LoginInput } } },
  },
  responses: {
    200: jsonResponse(ApiResponseSchema(LoginResultDto), '密码验证通过，需 MFA 二次验证'),
    401: jsonResponse(ErrorResponseSchema, '用户名或密码错误'),
    423: jsonResponse(ErrorResponseSchema, '失败次数过多已锁定'),
    502: jsonResponse(ErrorResponseSchema, '登录服务不可用'),
  },
})

const mfaStatusRoute = createRoute({
  method: 'get',
  path: '/mfa/status',
  tags: ['auth'],
  summary: '查询账号是否已绑定 MFA',
  request: {
    query: z.object({
      username: z.string().min(1).max(64).openapi({ example: 'zhangsan' }),
    }),
  },
  responses: {
    200: jsonResponse(ApiResponseSchema(MfaStatusDto), '成功'),
  },
})

const mfaSetupRoute = createRoute({
  method: 'post',
  path: '/mfa/setup',
  tags: ['auth'],
  summary: 'MFA 首次绑定：生成二维码（先验密）',
  request: {
    body: { required: true, content: { 'application/json': { schema: MfaSetupInput } } },
  },
  responses: {
    200: jsonResponse(ApiResponseSchema(MfaSetupResultDto), '二维码已生成（5 分钟内有效）'),
    401: jsonResponse(ErrorResponseSchema, '密码错误'),
    409: jsonResponse(ErrorResponseSchema, '已绑定 MFA'),
  },
})

const mfaConfirmRoute = createRoute({
  method: 'post',
  path: '/mfa/confirm',
  tags: ['auth'],
  summary: 'MFA 首次绑定确认（验证动态码并登录）',
  request: {
    body: { required: true, content: { 'application/json': { schema: MfaTokenInput } } },
  },
  responses: {
    200: jsonResponse(ApiResponseSchema(MeDto), '绑定成功并已登录'),
    401: jsonResponse(ErrorResponseSchema, '动态码错误'),
    410: jsonResponse(ErrorResponseSchema, '绑定已过期'),
  },
})

const mfaVerifyRoute = createRoute({
  method: 'post',
  path: '/mfa/verify',
  tags: ['auth'],
  summary: 'MFA 登录验证（已绑定账号）',
  request: {
    body: { required: true, content: { 'application/json': { schema: MfaTokenInput } } },
  },
  responses: {
    200: jsonResponse(ApiResponseSchema(MeDto), '登录成功'),
    400: jsonResponse(ErrorResponseSchema, '未绑定 MFA'),
    401: jsonResponse(ErrorResponseSchema, '动态码错误'),
  },
})

const mfaUnbindRoute = createRoute({
  method: 'post',
  path: '/mfa/unbind',
  tags: ['auth'],
  summary: '解绑 MFA（重验密码 + 动态码）',
  request: {
    body: { required: true, content: { 'application/json': { schema: MfaUnbindInput } } },
  },
  responses: {
    200: jsonResponse(ApiResponseSchema(z.object({ ok: z.literal(true) })), '已解绑'),
    401: jsonResponse(ErrorResponseSchema, '密码或动态码错误'),
  },
})

const logoutRoute = createRoute({
  method: 'post',
  path: '/logout',
  tags: ['auth'],
  summary: '退出登录（拉黑当前 token、关闭该用户全部会话）',
  middleware: [requireAuth()],
  responses: {
    200: jsonResponse(ApiResponseSchema(z.object({ ok: z.literal(true) })), '已退出'),
    401: jsonResponse(ErrorResponseSchema, '未登录'),
  },
})

const meRoute = createRoute({
  method: 'get',
  path: '/me',
  tags: ['auth'],
  summary: '当前登录用户（守卫 hydrate）',
  middleware: [requireAuth()],
  responses: {
    200: jsonResponse(ApiResponseSchema(MeDto), '成功'),
    401: jsonResponse(ErrorResponseSchema, '未登录'),
  },
})

export function registerAuthRoutes(app: App): void {
  app.openapi(loginRoute, async (c) => {
    const input = c.req.valid('json')
    return ok(c, await authService.login(input, clientIp(c)))
  })

  app.openapi(mfaStatusRoute, async (c) => {
    return ok(c, await authService.mfaStatus(c.req.valid('query').username))
  })

  app.openapi(mfaSetupRoute, async (c) => {
    const input = c.req.valid('json')
    return ok(c, await authService.mfaSetup(input, clientIp(c)))
  })

  app.openapi(mfaConfirmRoute, async (c) => {
    const { username, role } = await authService.mfaConfirm(c.req.valid('json'))
    setAuthCookie(c, signToken(username, role))
    return ok(c, { username, role })
  })

  app.openapi(mfaVerifyRoute, async (c) => {
    const { username, role } = await authService.mfaVerify(c.req.valid('json'))
    setAuthCookie(c, signToken(username, role))
    return ok(c, { username, role })
  })

  app.openapi(mfaUnbindRoute, async (c) => {
    await authService.mfaUnbind(c.req.valid('json'), clientIp(c))
    return ok(c, { ok: true as const })
  })

  app.openapi(logoutRoute, async (c) => {
    const token = getCookie(c, AUTH_COOKIE)
    if (token) {
      revokeToken(token)
    }
    // 关闭该用户全部活跃 agent 会话（动态 import 规避 auth <-> agent 循环依赖）
    const { closeAllSessionsForUser } = await import('@/modules/agent/session-registry')
    await closeAllSessionsForUser(c.get('username'), 'logout')
    deleteCookie(c, AUTH_COOKIE, { path: '/' })
    logger.info({ username: c.get('username') }, '用户已退出登录')
    return ok(c, { ok: true as const })
  })

  app.openapi(meRoute, (c) => {
    // role 取自已验签 token（requireAuth 已通过）；role 字段之前的旧 token 按 user 处理
    const token = getCookie(c, AUTH_COOKIE)
    return ok(c, { username: c.get('username'), role: token ? roleFromToken(token) : 'user' })
  })
}
