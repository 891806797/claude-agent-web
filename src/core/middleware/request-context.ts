import type { MiddlewareHandler } from 'hono'
import { nanoid } from 'nanoid'
import { requestContextStorage, rootLogger } from '../logger'
import type { AppEnv } from '../types'

/**
 * 请求上下文中间件 —— 必须最先注册（access-log 与所有业务日志都依赖它）。
 *
 * 职责：
 *   1. traceId：优先透传上游 x-request-id（微服务链路串联），否则 nanoid() 生成
 *   2. 绑定 traceId 的 child logger 写入 c.var 与 AsyncLocalStorage（任意层 log() 自动携带）
 *   3. 响应头回写 x-request-id（c.header 在 next 前调用，成功/错误响应都会携带）
 */
export function requestContext(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const traceId = c.req.header('x-request-id') ?? nanoid()
    const logger = rootLogger.child({ traceId })

    c.set('traceId', traceId)
    c.set('logger', logger)
    c.header('x-request-id', traceId)

    await requestContextStorage.run({ traceId, logger }, next)
  }
}
