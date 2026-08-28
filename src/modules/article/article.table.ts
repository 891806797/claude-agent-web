import { index, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

/**
 * articles 表定义 —— 只依赖 drizzle-orm，不依赖任何业务代码（drizzle-kit 独立加载）。
 * 列名由全局 casing: 'snake_case' 自动生成（camelCase -> snake_case），禁止手写列名字符串。
 */
export const articleStatus = pgEnum('article_status', ['draft', 'published'])

export const articles = pgTable(
  'articles',
  {
    id: uuid().primaryKey().defaultRandom(), // PG13+ 内置 gen_random_uuid()
    title: text().notNull(),
    content: text().notNull().default(''),
    status: articleStatus().notNull().default('draft'),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index('articles_status_idx').on(t.status)],
)

export type ArticleRow = typeof articles.$inferSelect
export type NewArticleRow = typeof articles.$inferInsert
export type ArticleStatus = (typeof articleStatus.enumValues)[number]
