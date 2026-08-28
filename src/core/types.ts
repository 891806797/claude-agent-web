import type { OpenAPIHono } from '@hono/zod-openapi'
import type { Logger } from 'pino'

/** 请求上下文：由 request-context 中间件写入 AsyncLocalStorage，任意层 log() 自动携带 */
export interface RequestContext {
  traceId: string
  logger: Logger
}

/**
 * Hono 环境类型：所有通过 c.get() 读取的请求级变量必须在此登记。
 * 新增横切能力（如认证）时先在此声明，再在中间件里 c.set。
 */
export type AppEnv = {
  Variables: {
    traceId: string
    logger: Logger
    // ★ 认证扩展点（预留，未实现）：接入认证后取消注释并在中间件中 c.set
    // user: { id: string; roles: string[] }
  }
}

/** 全项目统一的 app 类型别名 */
export type App = OpenAPIHono<AppEnv>
