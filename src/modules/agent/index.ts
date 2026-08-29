import { createApp } from '@/core/create-app'
import { requireAuth } from '@/core/middleware/auth'
import { registerAgentRoutes } from './agent.route'

const app = createApp()
// 模块级守卫：agent 全部接口需登录（username 取自 JWT，多用户隔离的入口）
app.use('*', requireAuth())
registerAgentRoutes(app)

/** agent 模块路由，由 src/routes/index.ts 挂载到 /api/agent */
export const agentApp = app
