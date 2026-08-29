import { createApp } from '@/core/create-app'
import { registerAuthRoutes } from './auth.route'

const app = createApp()
registerAuthRoutes(app)

/** auth 模块路由，由 src/routes/index.ts 挂载到 /api/auth */
export const authApp = app
