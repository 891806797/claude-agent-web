import { defineConfig } from 'drizzle-kit'

// 自包含配置：不 import src/ 下任何代码（drizzle-kit 用自己的 loader 独立加载本文件）
// 注意：必须用 `bunx drizzle-kit ...` 运行，bun 运行时才会自动加载 .env
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://app:app@localhost:5432/app',
  },
  // 列名自动 camelCase -> snake_case；须与 src/db/index.ts 中 drizzle() 的 casing 保持一致
  casing: 'snake_case',
})
