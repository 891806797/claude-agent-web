import { desc, eq, sql } from 'drizzle-orm'
import type { DbExecutor } from '@/db'
import { getOffset, type PageQuery } from '@/utils/pagination'
import type { CreateArticleData } from './article.schema'
import type { ArticleStatus } from './article.table'
import { type ArticleRow, articles } from './article.table'

/**
 * article 数据访问层 —— 只关心 SQL，不做业务判断、不抛业务错误，返回原始 Row。
 * 约定：首参一律 executor: DbExecutor（db 或事务 tx 皆可传入）。
 */
export interface ListArticlesFilter extends PageQuery {
  status?: ArticleStatus
}

export const articleRepository = {
  async list(
    executor: DbExecutor,
    filter: ListArticlesFilter,
  ): Promise<{ rows: ArticleRow[]; total: number }> {
    const where = filter.status ? eq(articles.status, filter.status) : undefined

    const rows = await executor
      .select()
      .from(articles)
      .where(where)
      .orderBy(desc(articles.createdAt))
      .limit(filter.pageSize)
      .offset(getOffset(filter))

    const [countRow] = await executor
      .select({ count: sql<number>`count(*)::int` })
      .from(articles)
      .where(where)

    return { rows, total: countRow?.count ?? 0 }
  },

  async findById(executor: DbExecutor, id: string): Promise<ArticleRow | undefined> {
    const [row] = await executor.select().from(articles).where(eq(articles.id, id)).limit(1)
    return row
  },

  async create(executor: DbExecutor, data: CreateArticleData): Promise<ArticleRow> {
    const [row] = await executor.insert(articles).values(data).returning()
    // insert returning 必返回插入的行
    return row!
  },

  async update(
    executor: DbExecutor,
    id: string,
    data: Partial<CreateArticleData>,
  ): Promise<ArticleRow | undefined> {
    const [row] = await executor.update(articles).set(data).where(eq(articles.id, id)).returning()
    return row
  },

  async remove(executor: DbExecutor, id: string): Promise<boolean> {
    const removed = await executor
      .delete(articles)
      .where(eq(articles.id, id))
      .returning({ id: articles.id })
    return removed.length > 0
  },
}
