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
  // 迁移记录表 __drizzle_migrations 所在 schema（默认 public）；走 .env 的 MIGRATIONS_SCHEMA。
  // 须与 src/db/migrate.ts 的 migrationsSchema 保持一致（两条迁移路径共享同一份重放记录）。
  // 注意：migrator 先 ensure 记录表再跑迁移 SQL，故该 schema 必须已存在——默认 public 最稳；
  //       若设为业务 schema，需 DBA 预创建，否则首次迁移 ensure 即失败。
  migrations: { schema: process.env.MIGRATIONS_SCHEMA ?? 'public' },
})
