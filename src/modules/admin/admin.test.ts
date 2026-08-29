import { describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { app } from '@/app'
import { db } from '@/db'
import { signToken } from '@/modules/auth/jwt'

/**
 * admin API 集成测试：模块级 requireAuth 覆盖（401）、登录后三个只读/幂等入口可用。
 * reset-mfa 的写路径与 404 分支依赖真实用户数据，走手工验证。
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

describe.skipIf(!dbReady)('admin API（集成测试）', () => {
  test('未登录访问 admin 域返回 401（requireAuth 覆盖 /api/admin/*）', async () => {
    const usersRes = await app.request('/api/admin/users')
    expect(usersRes.status).toBe(401)

    const statsRes = await app.request('/api/admin/stats')
    expect(statsRes.status).toBe(401)

    const resetRes = await app.request('/api/admin/users/someone/reset-mfa', {
      method: 'POST',
      headers: JSON_HEADER,
    })
    expect(resetRes.status).toBe(401)
  })

  test('GET /api/admin/users 携带合法 cookie 返回用户数组', async () => {
    const token = signToken('it-test-user', 'user')
    const res = await app.request('/api/admin/users', {
      headers: { cookie: `token=${token}` },
    })
    const body = (await res.json()) as { data: unknown[] }
    expect(res.status).toBe(200)
    expect(Array.isArray(body.data)).toBe(true)
  })

  test('GET /api/admin/stats 携带合法 cookie 返回统计', async () => {
    const token = signToken('it-test-user', 'user')
    const res = await app.request('/api/admin/stats', {
      headers: { cookie: `token=${token}` },
    })
    const body = (await res.json()) as { data: { active: unknown } }
    expect(res.status).toBe(200)
    expect(body.data).toHaveProperty('active')
  })

  test('POST /api/admin/users/{username}/reset-mfa 用户不存在返回 404', async () => {
    const token = signToken('it-test-user', 'user')
    const res = await app.request('/api/admin/users/never-existed-user-xyz/reset-mfa', {
      method: 'POST',
      headers: { cookie: `token=${token}`, ...JSON_HEADER },
    })
    expect(res.status).toBe(404)
  })
})
