import { cors } from 'hono/cors'
import { createApp } from '@/core/create-app'
import { accessLog } from '@/core/middleware/access-log'
import { errorHandler } from '@/core/middleware/error-handler'
import { notFoundHandler } from '@/core/middleware/not-found'
import { requestContext } from '@/core/middleware/request-context'
import type { App } from '@/core/types'
import { env } from '@/env'
import { registerRoutes } from '@/routes'

/**
 * 应用组装（中间件 -> 路由 -> 错误处理）—— 不监听端口，测试直接用 app.request()。
 * 新增全局中间件：在下方按序插入（requestContext 必须保持最先注册）。
 */
export function buildApp(): App {
  const app = createApp()

  // ① 请求上下文（traceId + logger），必须最先
  app.use('*', requestContext())
  // ② 访问日志
  app.use('*', accessLog())
  // ③ CORS（配置了 CORS_ORIGIN 才启用）
  if (env.CORS_ORIGIN) {
    app.use('*', cors({ origin: env.CORS_ORIGIN.split(',').map((s) => s.trim()) }))
  }

  // 路由
  registerRoutes(app)

  // 错误处理（放最后）
  app.onError(errorHandler)
  app.notFound(notFoundHandler)

  return app
}

/** 应用单例：测试 app.request() / 入口 app.fetch */
export const app = buildApp()
