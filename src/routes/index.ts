import { Scalar } from '@scalar/hono-api-reference'
import { sql } from 'drizzle-orm'
import { registerFrontendRoutes } from '@/core/frontend'
import type { App } from '@/core/types'
import { db } from '@/db'
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

  // ---- OpenAPI 文档 ----
  app.doc31('/openapi.json', {
    openapi: '3.1.0',
    info: { title: 'claude-agent-web API', version: '1.0.0' },
  })
  app.get('/docs', Scalar({ url: '/openapi.json' }))

  // ---- 编译版前端（--asset 嵌入的 ui/dist；dev 模式内部自动跳过）----
  registerFrontendRoutes(app)
}
