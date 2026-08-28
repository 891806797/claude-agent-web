import type { NotFoundHandler } from 'hono'
import type { AppEnv } from '../types'

/** 统一 404（app.notFound 注册）：未匹配路由的兜底响应 */
export const notFoundHandler: NotFoundHandler<AppEnv> = (c) => {
  return c.json(
    { error: { code: 'NOT_FOUND', message: '资源不存在', traceId: c.get('traceId') } },
    404,
  )
}
