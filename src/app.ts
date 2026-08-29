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

  // 子路径部署（BASE_URL 如 /claude，nginx 反代场景）：外层做"剥前缀转发"而非 route 挂载——
  // route 挂载下 c.req.path 仍带前缀，core/frontend 的静态服务会拼出错误路径。
  // 转发方式让内层 app（路由/静态/中间件）全部按根路径逻辑执行，core 无需感知前缀，
  // 且 requestContext/accessLog 仍只执行一遍。
  if (!env.BASE_URL) return app
  const base = env.BASE_URL
  const root = createApp()
  root.all('*', (c) => {
    const url = new URL(c.req.url)
    if (url.pathname === base) return c.redirect(`${base}/`)
    if (url.pathname.startsWith(`${base}/`)) {
      url.pathname = url.pathname.slice(base.length) || '/'
      // 原请求作 init 透传（method/headers/body 等按属性逐项读取，标准行为），仅 TS 类型不识别
      return app.fetch(new Request(url.toString(), c.req.raw as RequestInit))
    }
    return c.notFound()
  })
  root.onError(errorHandler)
  root.notFound(notFoundHandler)
  return root
}

/** 应用单例：测试 app.request() / 入口 app.fetch */
export const app = buildApp()
