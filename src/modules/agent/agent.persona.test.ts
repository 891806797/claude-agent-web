import { describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { app } from '@/app'
import { db } from '@/db'
import { signToken } from '@/modules/auth/jwt'
import { agentPersonas } from './agent.table'

/**
 * 智能体定义（personas）API 集成测试：CRUD 闭环 + 鉴权覆盖 + 重名/404 分支。
 * openSession 注入链与切换端点依赖真实 CLI 子进程，走手工验证。
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

/** 测试内建的 persona 清理（幂等；防残留污染下次运行） */
async function cleanupPersona(name: string): Promise<void> {
  await db.delete(agentPersonas).where(sql`name = ${name}`)
}

describe.skipIf(!dbReady)('agent personas API（集成测试）', () => {
  test('未登录访问 personas 返回 401（requireAuth 覆盖）', async () => {
    const listRes = await app.request('/api/agent/personas')
    expect(listRes.status).toBe(401)

    const createRes = await app.request('/api/agent/personas', {
      method: 'POST',
      headers: JSON_HEADER,
      body: JSON.stringify({ name: 'x', description: '', systemPrompt: 'y' }),
    })
    expect(createRes.status).toBe(401)
  })

  test('CRUD 闭环：建 → 列表 → 更新 → 删除', async () => {
    const token = signToken('it-persona-user', 'user')
    const cookie = { cookie: `token=${token}` }
    const name = `it-persona-${Date.now()}`
    try {
      // 建
      const createRes = await app.request('/api/agent/personas', {
        method: 'POST',
        headers: { ...cookie, ...JSON_HEADER },
        body: JSON.stringify({ name, description: '测试用', systemPrompt: '你是测试智能体' }),
      })
      const created = (await createRes.json()) as { data: { id: string; name: string } }
      expect(createRes.status).toBe(201)
      expect(created.data.name).toBe(name)
      const id = created.data.id

      // 列表含它
      const listRes = await app.request('/api/agent/personas', { headers: cookie })
      const list = (await listRes.json()) as { data: Array<{ id: string }> }
      expect(listRes.status).toBe(200)
      expect(list.data.some((p) => p.id === id)).toBe(true)

      // 更新（改名 + 改提示词）
      const updateRes = await app.request(`/api/agent/personas/${id}`, {
        method: 'PUT',
        headers: { ...cookie, ...JSON_HEADER },
        body: JSON.stringify({ description: '已更新', systemPrompt: '新提示词' }),
      })
      expect(updateRes.status).toBe(200)

      // 删除 → 列表不再含它
      const deleteRes = await app.request(`/api/agent/personas/${id}`, {
        method: 'DELETE',
        headers: cookie,
      })
      expect(deleteRes.status).toBe(204)
      const list2 = (await (
        await app.request('/api/agent/personas', { headers: cookie })
      ).json()) as { data: Array<{ id: string }> }
      expect(list2.data.some((p) => p.id === id)).toBe(false)
    } finally {
      await cleanupPersona(name)
    }
  })

  test('重名创建返回 409；更新/删除不存在返回 404', async () => {
    const token = signToken('it-persona-user', 'user')
    const cookie = { cookie: `token=${token}` }
    const name = `it-persona-dup-${Date.now()}`
    try {
      const createRes = await app.request('/api/agent/personas', {
        method: 'POST',
        headers: { ...cookie, ...JSON_HEADER },
        body: JSON.stringify({ name, description: '', systemPrompt: '第一个' }),
      })
      expect(createRes.status).toBe(201)
      const { data } = (await createRes.json()) as { data: { id: string } }

      // 同名再建 → 409
      const dupRes = await app.request('/api/agent/personas', {
        method: 'POST',
        headers: { ...cookie, ...JSON_HEADER },
        body: JSON.stringify({ name, description: '', systemPrompt: '第二个' }),
      })
      expect(dupRes.status).toBe(409)

      // 不存在的 id → 404
      const ghostId = '00000000-0000-4000-8000-000000000000'
      const updateRes = await app.request(`/api/agent/personas/${ghostId}`, {
        method: 'PUT',
        headers: { ...cookie, ...JSON_HEADER },
        body: JSON.stringify({ description: 'x' }),
      })
      expect(updateRes.status).toBe(404)
      const deleteRes = await app.request(`/api/agent/personas/${ghostId}`, {
        method: 'DELETE',
        headers: cookie,
      })
      expect(deleteRes.status).toBe(404)

      // 改成自己的名字（非重名）应放行
      const selfRename = await app.request(`/api/agent/personas/${data.id}`, {
        method: 'PUT',
        headers: { ...cookie, ...JSON_HEADER },
        body: JSON.stringify({ name }),
      })
      expect(selfRename.status).toBe(200)
    } finally {
      await cleanupPersona(name)
    }
  })
})
