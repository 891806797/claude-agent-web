import type { MiddlewareHandler } from 'hono'
import { getCookie } from 'hono/cookie'
import { verifyToken } from '@/modules/auth/jwt'
import { AppError } from '../app-error'
import { requestContextStorage } from '../logger'
import type { AppEnv } from '../types'

/**
 * 认证中间件 -- 身份唯一来源是 HttpOnly cookie 中的 JWT（服务端验签解出 username），
 * 绝不信任客户端 header 声明的用户名。
 *
 * 副作用（可观测性关键）：
 *   1. c.set('username') -- handler 通过 c.get('username') 取当前用户
 *   2. mutate 本次请求的 ALS store.logger（child({ username })）--
 *      之后该请求内所有 log()（含 access-log 收尾日志）自动携带 username
 */

export const AUTH_COOKIE = 'token'

export function requireAuth(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const token = getCookie(c, AUTH_COOKIE)
    const username = token ? verifyToken(token) : null
    if (!username) {
      throw new AppError('UNAUTHORIZED')
    }

    c.set('username', username)
    const store = requestContextStorage.getStore()
    if (store) {
      store.logger = store.logger.child({ username })
    }

    await next()
  }
}
