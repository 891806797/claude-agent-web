import { Scalar } from '@scalar/hono-api-reference'
import { sql } from 'drizzle-orm'
import { registerFrontendRoutes } from '@/core/frontend'
import type { App } from '@/core/types'
import { db } from '@/db'
import { env } from '@/env'
import { adminApp } from '@/modules/admin'
import { agentApp } from '@/modules/agent'
import { authApp } from '@/modules/auth'

/**
 * 路由总表 —— 看一眼即知全部对外入口。新增模块在此挂载。
 */
export function registerRoutes(app: App): void {
  // 存活探针（不依赖数据库）
  app.get('/healthz', (c) => c.json({ data: 'ok' }))

  // 就绪探针（验证数据库连接）
  app.get('/readyz', async (c) => {
    await db.execute(sql`select 1`)
    return c.json({ data: 'ok' })
  })

  // ---- 业务模块 ----
  app.route('/api/auth', authApp)
  app.route('/api/agent', agentApp)
  app.route('/api/admin', adminApp)

  // ---- OpenAPI 文档 ----
  // servers 带部署前缀：子路径部署（BASE_URL）时 Scalar 页面试发请求才能命中真实路径
  app.doc31('/openapi.json', {
    openapi: '3.1.0',
    info: { title: 'claude-agent-web API', version: '1.0.0' },
    servers: [{ url: env.BASE_URL || '/' }],
  })
  app.get('/docs', Scalar({ url: `${env.BASE_URL}/openapi.json` }))

  // ---- 编译版前端（--asset 嵌入的 ui/dist；dev 模式内部自动跳过）----
  registerFrontendRoutes(app)
}
