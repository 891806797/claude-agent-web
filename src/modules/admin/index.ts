import { createApp } from '@/core/create-app'
import { requireAuth } from '@/core/middleware/auth'
import { registerAdminRoutes } from './admin.route'

const app = createApp()
// 模块级守卫：管理端全部接口需登录；未来 requireAdmin（role 校验）也在此挂载
app.use('*', requireAuth())
registerAdminRoutes(app)

/** admin 模块路由，由 src/routes/index.ts 挂载到 /api/admin */
export const adminApp = app
