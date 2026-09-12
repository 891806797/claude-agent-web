import { createApp } from '@/core/create-app'
import { registerSystemRoutes } from './system.route'

const app = createApp()
registerSystemRoutes(app)

/** system 模块路由，由 src/routes/index.ts 挂载到 /api/system */
export const systemApp = app
