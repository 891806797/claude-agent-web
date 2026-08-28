import { createApp } from '@/core/create-app'
import { registerArticleRoutes } from './article.route'

const app = createApp()
registerArticleRoutes(app)

/** article 模块路由，由 src/routes/index.ts 挂载到 /api/articles */
export const articleApp = app
