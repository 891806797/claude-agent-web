import { pgSchema } from 'drizzle-orm/pg-core'

// 不 import @/env：本文件被 drizzle-kit 独立加载（node loader，无 Bun 全局），
// 与 drizzle.config.ts 读 process.env.DATABASE_URL 同理。运行时 bun 已加载 .env，process.env 可用。
// generate 时读到的值会字面写入迁移 SQL；运行时须与 .env 保持一致。
// 默认值须与 src/env.ts 中 DB_SCHEMA 的 default 保持一致。
export const appSchema = pgSchema(process.env.DB_SCHEMA ?? 'claude_agent_web')
