import { describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { app } from '@/app'
import { db } from '@/db'
import { articles } from './article.table'

/**
 * article 集成测试：app.request() 直接调用（无需起端口）。
 * 约定：每个请求必须带 content-type: application/json（否则 body 静默解析为空）。
 * 数据库不可用时整体跳过，不阻塞无库环境的测试运行。
 */
let dbReady = false
try {
  await db.execute(sql`select 1`)
  dbReady = true
} catch {
  dbReady = false
}

const JSON_HEADER = { 'content-type': 'application/json' }

interface ArticleData {
  id: string
  title: string
  content: string
  status: string
}

async function createArticle(title = '测试文章', content = '测试内容'): Promise<ArticleData> {
  const res = await app.request('/api/articles', {
    method: 'POST',
    headers: JSON_HEADER,
    body: JSON.stringify({ title, content }),
  })
  const body = (await res.json()) as { data: ArticleData }
  return body.data
}

describe.skipIf(!dbReady)('article API（集成测试）', () => {
  test('GET /healthz 与 /readyz 健康检查', async () => {
    expect((await app.request('/healthz')).status).toBe(200)
    expect((await app.request('/readyz')).status).toBe(200)
  })

  test('POST /api/articles 创建成功返回 201 与 DTO', async () => {
    const res = await app.request('/api/articles', {
      method: 'POST',
      headers: JSON_HEADER,
      body: JSON.stringify({ title: '第一篇文章', content: 'hello' }),
    })
    const body = (await res.json()) as { data: ArticleData }
    expect(res.status).toBe(201)
    expect(body.data.id).toBeTruthy()
    expect(body.data.title).toBe('第一篇文章')
    expect(body.data.status).toBe('draft')
  })

  test('POST 缺少 title 返回 422 与错误树', async () => {
    const res = await app.request('/api/articles', {
      method: 'POST',
      headers: JSON_HEADER,
      body: JSON.stringify({ content: 'no title' }),
    })
    const body = (await res.json()) as { error: { code: string; traceId: string } }
    expect(res.status).toBe(422)
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.traceId).toBeTruthy()
  })

  test('POST 不带 content-type 返回 422（防御 body 静默为空）', async () => {
    const res = await app.request('/api/articles', {
      method: 'POST',
      body: JSON.stringify({ title: 'x' }),
    })
    expect(res.status).toBe(422)
  })

  test('GET /api/articles 分页列表', async () => {
    await db.delete(articles)
    await createArticle('a1')
    await createArticle('a2')
    await createArticle('a3')

    const res = await app.request('/api/articles?page=1&pageSize=2')
    const body = (await res.json()) as {
      data: { list: ArticleData[]; total: number; page: number; pageSize: number }
    }
    expect(res.status).toBe(200)
    expect(body.data.total).toBe(3)
    expect(body.data.list).toHaveLength(2)
    expect(body.data.page).toBe(1)
    expect(body.data.pageSize).toBe(2)
  })

  test('GET query page=0 返回 422', async () => {
    const res = await app.request('/api/articles?page=0')
    expect(res.status).toBe(422)
  })

  test('GET /api/articles/{id} 详情、404 与非法 uuid', async () => {
    const created = await createArticle()

    const okRes = await app.request(`/api/articles/${created.id}`)
    expect(okRes.status).toBe(200)

    const notFoundRes = await app.request('/api/articles/00000000-0000-0000-0000-000000000000')
    const notFoundBody = (await notFoundRes.json()) as { error: { code: string; traceId: string } }
    expect(notFoundRes.status).toBe(404)
    expect(notFoundBody.error.code).toBe('ARTICLE_NOT_FOUND')
    // 响应头与错误体的 traceId 一致
    expect(notFoundRes.headers.get('x-request-id')).toBe(notFoundBody.error.traceId)

    const badUuidRes = await app.request('/api/articles/not-a-uuid')
    expect(badUuidRes.status).toBe(422)
  })

  test('PUT 更新字段、空 body 幂等返回原记录', async () => {
    const created = await createArticle('旧标题', '旧内容')

    const updatedRes = await app.request(`/api/articles/${created.id}`, {
      method: 'PUT',
      headers: JSON_HEADER,
      body: JSON.stringify({ title: '新标题' }),
    })
    const updatedBody = (await updatedRes.json()) as { data: ArticleData }
    expect(updatedRes.status).toBe(200)
    expect(updatedBody.data.title).toBe('新标题')
    // 未提交的字段保持原值
    expect(updatedBody.data.content).toBe('旧内容')

    const emptyRes = await app.request(`/api/articles/${created.id}`, {
      method: 'PUT',
      headers: JSON_HEADER,
      body: JSON.stringify({}),
    })
    const emptyBody = (await emptyRes.json()) as { data: ArticleData }
    expect(emptyRes.status).toBe(200)
    expect(emptyBody.data.title).toBe('新标题')
  })

  test('DELETE 删除后再次删除返回 404', async () => {
    const created = await createArticle()

    const delRes = await app.request(`/api/articles/${created.id}`, { method: 'DELETE' })
    expect(delRes.status).toBe(204)

    const againRes = await app.request(`/api/articles/${created.id}`, { method: 'DELETE' })
    expect(againRes.status).toBe(404)
  })

  test('x-request-id 透传并在响应头回写', async () => {
    const res = await app.request('/api/articles', {
      headers: { 'x-request-id': 'my-custom-trace-id' },
    })
    expect(res.headers.get('x-request-id')).toBe('my-custom-trace-id')
  })

  test('未匹配路由返回统一 404 结构', async () => {
    const res = await app.request('/api/unknown')
    const body = (await res.json()) as { error: { code: string } }
    expect(res.status).toBe(404)
    expect(body.error.code).toBe('NOT_FOUND')
  })
})
