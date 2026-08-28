import { AppError } from '@/core/app-error'
import { log } from '@/core/logger'
import type { Paginated } from '@/core/response'
import { db } from '@/db'
import { articleRepository, type ListArticlesFilter } from './article.repository'
import {
  type Article,
  type CreateArticleData,
  toArticle,
  type UpdateArticleData,
} from './article.schema'

/**
 * article 业务层 —— 不 import hono 任何内容（可独立单测）。
 * 约定：业务错误唯一表达方式 throw AppError；默认注入 db，跨表事务时显式传 tx：
 *   await db.transaction(async (tx) => articleRepository.create(tx, data))
 */
export const articleService = {
  async list(filter: ListArticlesFilter): Promise<Paginated<Article>> {
    const { rows, total } = await articleRepository.list(db, filter)
    return { list: rows.map(toArticle), total, page: filter.page, pageSize: filter.pageSize }
  },

  async getById(id: string): Promise<Article> {
    const row = await articleRepository.findById(db, id)
    if (!row) {
      throw new AppError('ARTICLE_NOT_FOUND')
    }
    return toArticle(row)
  },

  async create(data: CreateArticleData): Promise<Article> {
    const row = await articleRepository.create(db, data)
    log().info({ articleId: row.id }, '文章已创建')
    return toArticle(row)
  },

  async update(id: string, data: UpdateArticleData): Promise<Article> {
    // 空更新幂等处理：直接返回当前记录
    if (Object.keys(data).length === 0) {
      return articleService.getById(id)
    }
    const row = await articleRepository.update(db, id, data)
    if (!row) {
      throw new AppError('ARTICLE_NOT_FOUND')
    }
    return toArticle(row)
  },

  async remove(id: string): Promise<void> {
    const removed = await articleRepository.remove(db, id)
    if (!removed) {
      throw new AppError('ARTICLE_NOT_FOUND')
    }
  },
}
