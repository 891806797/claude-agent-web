import { describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { app } from '@/app'
import { db } from '@/db'
import { signToken } from './jwt'

/**
 * auth API 集成测试（无需 SOAP 的路径）：
 * me 鉴权（401/200）、mfa/status、logout 黑名单闭环。
 * login/mfa:setup 等全链路依赖公司 OA Web Service（内网），走手工验证。
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

describe.skipIf(!dbReady)('auth API（集成测试）', () => {
  test('GET /api/auth/me 未登录返回 401 UNAUTHORIZED', async () => {
    const res = await app.request('/api/auth/me')
    const body = (await res.json()) as { error: { code: string; traceId: string } }
    expect(res.status).toBe(401)
    expect(body.error.code).toBe('UNAUTHORIZED')
    expect(body.error.traceId).toBeTruthy()
  })

  test('GET /api/auth/me 携带合法 cookie 返回 username', async () => {
    const token = signToken('it-test-user')
    const res = await app.request('/api/auth/me', {
      headers: { cookie: `token=${token}` },
    })
    const body = (await res.json()) as { data: { username: string } }
    expect(res.status).toBe(200)
    expect(body.data.username).toBe('it-test-user')
  })

  test('POST /api/auth/logout 后同 token 访问 me 返回 401（黑名单闭环）', async () => {
    const token = signToken('it-test-user')
    const cookie = { cookie: `token=${token}`, ...JSON_HEADER }

    const logoutRes = await app.request('/api/auth/logout', { method: 'POST', headers: cookie })
    expect(logoutRes.status).toBe(200)
    // Set-Cookie 清除（空值）
    const setCookie = logoutRes.headers.getSetCookie().join(';')
    expect(setCookie).toContain('token=')

    const meRes = await app.request('/api/auth/me', { headers: { cookie: `token=${token}` } })
    expect(meRes.status).toBe(401)
  })

  test('GET /api/auth/mfa/status 未知账号返回 bound=false', async () => {
    const res = await app.request('/api/auth/mfa/status?username=never-existed-user-xyz')
    const body = (await res.json()) as { data: { bound: boolean } }
    expect(res.status).toBe(200)
    expect(body.data.bound).toBe(false)
  })

  test('agent 域未登录返回 401（requireAuth 覆盖 /api/agent/*）', async () => {
    const res = await app.request('/api/agent/projects')
    expect(res.status).toBe(401)
  })
})
