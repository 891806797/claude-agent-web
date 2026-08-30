import { describe, expect, test } from 'bun:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { sql } from 'drizzle-orm'
import { app } from '@/app'
import { AppError } from '@/core/app-error'
import { db } from '@/db'
import { env } from '@/env'
import { signToken } from '@/modules/auth/jwt'
import { resolveProjectFile } from './agent.service'
import { agentProjects } from './agent.table'

/**
 * 项目文件内容 API（双击在线编辑）测试：
 * - resolveProjectFile 纯单测：目录穿越防护（无 DB 依赖，任何环境可跑）
 * - 集成测试：读 → 改 → 读回、404/415/422 分支、all 列表随增删变化（TTL 后）。
 *   数据库不可用时集成部分整体跳过（同 agent.persona.test.ts 模式）。
 */

// ===== resolveProjectFile（穿越防护，纯单测）=====

describe('resolveProjectFile', () => {
  const root = resolve(tmpdir(), 'proj')

  test('项目内相对路径 → 根内绝对路径', () => {
    expect(resolveProjectFile(root, 'a.txt')).toBe(join(root, 'a.txt'))
    expect(resolveProjectFile(root, 'src/lib/api.ts')).toBe(join(root, 'src', 'lib', 'api.ts'))
  })

  test('.. 穿越 / 绝对路径 → AGENT_FILE_PATH_INVALID', () => {
    for (const bad of ['../escape.txt', 'a/../../escape.txt', '/etc/passwd']) {
      try {
        resolveProjectFile(root, bad)
        expect.unreachable(`应拒绝：${bad}`)
      } catch (e) {
        expect(AppError.is(e)).toBe(true)
        expect((e as AppError).code).toBe('AGENT_FILE_PATH_INVALID')
      }
    }
  })

  test('同前缀目录不误伤：/proj-x 不是 /proj 的子路径', () => {
    expect(() => resolveProjectFile(root, '../proj-x/a.txt')).toThrow(AppError)
  })

  test('根目录为归一化口径（win32 小写+正斜杠）时不误伤', () => {
    const normalized = root.replaceAll('\\', '/')
    expect(resolveProjectFile(normalized, 'a.txt')).toBe(resolveProjectFile(root, 'a.txt'))
  })
})

// ===== 文件内容 API（集成测试）=====

let dbReady = false
try {
  await db.execute(sql`select 1`)
  dbReady = true
} catch {
  dbReady = false
}

const JSON_HEADER = { 'content-type': 'application/json' }

/** 集成测试基座：临时项目目录 + 注册 + 收尾清理（目录与 DB 行都幂等删） */
async function withProject(fn: (projectId: string, dir: string) => Promise<void>): Promise<void> {
  // createProject 有 AGENT_WORKSPACE_ROOT 白名单约束，临时目录必须落在其下（未配置则任意）
  const base = env.AGENT_WORKSPACE_ROOT ? resolve(env.AGENT_WORKSPACE_ROOT) : tmpdir()
  const dir = join(base, `file-edit-it-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  const name = `file-edit-it-${Date.now()}`
  const token = signToken('it-file-user', 'user')
  const cookie = { cookie: `token=${token}` }
  await mkdir(join(dir, 'sub'), { recursive: true })
  await writeFile(join(dir, 'a.txt'), 'hello 中文', 'utf8')
  await writeFile(join(dir, 'sub', 'note.md'), '# note', 'utf8')
  await writeFile(join(dir, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02]))
  let projectId = ''
  try {
    const res = await app.request('/api/agent/projects', {
      method: 'POST',
      headers: { ...cookie, ...JSON_HEADER },
      body: JSON.stringify({ name, path: dir }),
    })
    expect(res.status).toBe(201)
    projectId = ((await res.json()) as { data: { id: string } }).data.id
    await fn(projectId, dir)
  } finally {
    if (projectId) {
      try {
        await app.request(`/api/agent/projects/${projectId}`, {
          method: 'DELETE',
          headers: cookie,
        })
      } catch {
        // 清理尽力而为：下方还有 DB 兜底删除
      }
    }
    await db
      .delete(agentProjects)
      .where(sql`name = ${name}`)
      .catch(() => {})
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

describe.skipIf(!dbReady)('agent file API（集成测试）', () => {
  const authHeaders = (): Record<string, string> => ({
    cookie: `token=${signToken('it-file-user', 'user')}`,
  })

  test('未登录访问返回 401', async () => {
    const res = await app.request(
      '/api/agent/file?projectId=00000000-0000-0000-0000-000000000000&path=a.txt',
    )
    expect(res.status).toBe(401)
  })

  test('读 → 改 → 读回（UTF-8 闭环）', async () => {
    await withProject(async (projectId) => {
      const query = (p: string): string =>
        `/api/agent/file?projectId=${projectId}&path=${encodeURIComponent(p)}`

      // 读
      const readRes = await app.request(query('a.txt'), { headers: authHeaders() })
      expect(readRes.status).toBe(200)
      const read = (await readRes.json()) as { data: { content: string; size: number } }
      expect(read.data.content).toBe('hello 中文')

      // 改（保存后 size 为 utf8 字节数）
      const saveRes = await app.request('/api/agent/file', {
        method: 'PUT',
        headers: { ...authHeaders(), ...JSON_HEADER },
        body: JSON.stringify({ projectId, path: 'a.txt', content: 'world 改' }),
      })
      expect(saveRes.status).toBe(200)
      const saved = (await saveRes.json()) as { data: { size: number } }
      expect(saved.data.size).toBe(Buffer.byteLength('world 改', 'utf8'))

      // 读回
      const read2 = (await (
        await app.request(query('a.txt'), { headers: authHeaders() })
      ).json()) as { data: { content: string } }
      expect(read2.data.content).toBe('world 改')
    })
  })

  test('404：文件不存在（读/写）；415：二进制；422：路径穿越', async () => {
    await withProject(async (projectId) => {
      const query = (p: string): string =>
        `/api/agent/file?projectId=${projectId}&path=${encodeURIComponent(p)}`

      expect((await app.request(query('missing.txt'), { headers: authHeaders() })).status).toBe(404)
      const saveMissing = await app.request('/api/agent/file', {
        method: 'PUT',
        headers: { ...authHeaders(), ...JSON_HEADER },
        body: JSON.stringify({ projectId, path: 'missing.txt', content: 'x' }),
      })
      expect(saveMissing.status).toBe(404) // 仅允许改已存在文件

      expect((await app.request(query('bin.dat'), { headers: authHeaders() })).status).toBe(415)

      for (const bad of ['../escape.txt', 'a/../../escape.txt', '/etc/passwd', 'a\\b.txt']) {
        expect((await app.request(query(bad), { headers: authHeaders() })).status).toBe(422)
      }
      const badSave = await app.request('/api/agent/file', {
        method: 'PUT',
        headers: { ...authHeaders(), ...JSON_HEADER },
        body: JSON.stringify({ projectId, path: '../escape.txt', content: 'x' }),
      })
      expect(badSave.status).toBe(422)
    })
  })

  test('all=true 全量列表；TTL 过期后反映增删', async () => {
    await withProject(async (projectId, dir) => {
      const listUrl = `/api/agent/files?projectId=${projectId}&all=true`
      const list1 = (await (await app.request(listUrl, { headers: authHeaders() })).json()) as {
        data: string[]
      }
      expect(list1.data).toContain('a.txt')
      expect(list1.data).toContain('sub/note.md')

      // 增删后立即查仍命中 TTL 缓存（旧视图），过期后看到新视图
      await writeFile(join(dir, 'b.txt'), 'new', 'utf8')
      await rm(join(dir, 'sub', 'note.md')).catch(() => {})
      const list2 = (await (await app.request(listUrl, { headers: authHeaders() })).json()) as {
        data: string[]
      }
      expect(list2.data).not.toContain('b.txt') // TTL 窗口内：缓存视图

      await Bun.sleep(3100)
      const list3 = (await (await app.request(listUrl, { headers: authHeaders() })).json()) as {
        data: string[]
      }
      expect(list3.data).toContain('b.txt')
      expect(list3.data).not.toContain('sub/note.md')
    })
  })
})

describe.skipIf(!dbReady)('agent file 管理 API（创建/目录/删除/移动/上传，集成测试）', () => {
  const h = (): Record<string, string> => ({
    cookie: `token=${signToken('it-file-user', 'user')}`,
  })
  const jh = (): Record<string, string> => ({ ...h(), ...JSON_HEADER })
  const fileQuery = (projectId: string, p: string): string =>
    `/api/agent/file?projectId=${projectId}&path=${encodeURIComponent(p)}`

  test('创建文件：父目录递归建、可读回、重复 409、穿越/`.` 422', async () => {
    await withProject(async (projectId) => {
      const create = await app.request('/api/agent/file', {
        method: 'POST',
        headers: jh(),
        body: JSON.stringify({ projectId, path: 'deep/new/f.txt', content: '新建' }),
      })
      expect(create.status).toBe(201)
      const read = (await (
        await app.request(fileQuery(projectId, 'deep/new/f.txt'), { headers: h() })
      ).json()) as { data: { content: string } }
      expect(read.data.content).toBe('新建')

      const dup = await app.request('/api/agent/file', {
        method: 'POST',
        headers: jh(),
        body: JSON.stringify({ projectId, path: 'deep/new/f.txt' }),
      })
      expect(dup.status).toBe(409)

      for (const bad of ['../escape.txt', 'a/../b.txt', 'a/./b.txt']) {
        const res = await app.request('/api/agent/file', {
          method: 'POST',
          headers: jh(),
          body: JSON.stringify({ projectId, path: bad }),
        })
        expect(res.status).toBe(422)
      }
    })
  })

  test('创建目录：可写入文件、重复 409', async () => {
    await withProject(async (projectId) => {
      const create = await app.request('/api/agent/dir', {
        method: 'POST',
        headers: jh(),
        body: JSON.stringify({ projectId, path: 'docs/guide' }),
      })
      expect(create.status).toBe(201)
      // 目录可用性以能往里创建文件为准
      const put = await app.request('/api/agent/file', {
        method: 'POST',
        headers: jh(),
        body: JSON.stringify({ projectId, path: 'docs/guide/index.md', content: '# hi' }),
      })
      expect(put.status).toBe(201)

      const dup = await app.request('/api/agent/dir', {
        method: 'POST',
        headers: jh(),
        body: JSON.stringify({ projectId, path: 'docs/guide' }),
      })
      expect(dup.status).toBe(409)
    })
  })

  test('删除：文件与目录（递归）；不存在 404', async () => {
    await withProject(async (projectId) => {
      const delFile = await app.request(fileQuery(projectId, 'a.txt'), {
        method: 'DELETE',
        headers: h(),
      })
      expect(delFile.status).toBe(204)
      expect((await app.request(fileQuery(projectId, 'a.txt'), { headers: h() })).status).toBe(404)

      // sub/note.md 随目录递归删除
      const delDir = await app.request(fileQuery(projectId, 'sub'), {
        method: 'DELETE',
        headers: h(),
      })
      expect(delDir.status).toBe(204)
      expect(
        (await app.request(fileQuery(projectId, 'sub/note.md'), { headers: h() })).status,
      ).toBe(404)

      expect(
        (await app.request(fileQuery(projectId, 'nope.txt'), { method: 'DELETE', headers: h() }))
          .status,
      ).toBe(404)
    })
  })

  test('移动：文件/目录、目标父目录自动建、目标存在 409、目录移入自身 422', async () => {
    await withProject(async (projectId) => {
      const move = (from: string, to: string) =>
        app.request('/api/agent/file/move', {
          method: 'POST',
          headers: jh(),
          body: JSON.stringify({ projectId, from, to }),
        })

      // 文件移动到不存在的目录（父目录自动创建）
      expect((await move('a.txt', 'archive/a.txt')).status).toBe(200)
      const read = (await (
        await app.request(fileQuery(projectId, 'archive/a.txt'), { headers: h() })
      ).json()) as { data: { content: string } }
      expect(read.data.content).toBe('hello 中文')
      expect((await app.request(fileQuery(projectId, 'a.txt'), { headers: h() })).status).toBe(404)

      // 目录整体移动（内容跟随）
      expect((await move('sub', 'moved/sub')).status).toBe(200)
      const inner = (await (
        await app.request(fileQuery(projectId, 'moved/sub/note.md'), { headers: h() })
      ).json()) as { data: { content: string } }
      expect(inner.data.content).toBe('# note')

      expect((await move('archive/a.txt', 'archive/a.txt')).status).toBe(200) // no-op 幂等
      expect((await move('moved/sub/note.md', 'bin.dat')).status).toBe(409) // 目标已存在
      expect((await move('moved/sub', 'moved/sub/inside')).status).toBe(422) // 移入自身内部
    })
  })

  test('上传：base64 落盘、目标目录、同名 409、非法名 422、超限 413', async () => {
    await withProject(async (projectId) => {
      const upload = (body: unknown) =>
        app.request('/api/agent/file/upload', {
          method: 'POST',
          headers: jh(),
          body: JSON.stringify(body),
        })
      const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64')

      const ok1 = await upload({
        projectId,
        dir: 'assets',
        files: [
          { name: 'logo.txt', contentBase64: b64('图片内容') },
          { name: 'note2.md', contentBase64: b64('# n') },
        ],
      })
      expect(ok1.status).toBe(200)
      const saved = (await ok1.json()) as { data: { saved: string[] } }
      expect(saved.data.saved).toEqual(['assets/logo.txt', 'assets/note2.md'])
      const read = (await (
        await app.request(fileQuery(projectId, 'assets/logo.txt'), { headers: h() })
      ).json()) as { data: { content: string } }
      expect(read.data.content).toBe('图片内容')

      expect(
        (
          await upload({
            projectId,
            dir: 'assets',
            files: [{ name: 'logo.txt', contentBase64: b64('x') }],
          })
        ).status,
      ).toBe(409)
      expect(
        (await upload({ projectId, files: [{ name: 'a/b.txt', contentBase64: b64('x') }] })).status,
      ).toBe(422)
      expect(
        (await upload({ projectId, files: [{ name: '..', contentBase64: b64('x') }] })).status,
      ).toBe(422)
      // 真实 1.1MB 内容的 base64（约 1.47M 字符，过 zod 长度筛）→ service 字节校验 413
      const bigB64 = Buffer.from('A'.repeat(1_100_000), 'utf8').toString('base64')
      expect(
        (await upload({ projectId, files: [{ name: 'big.bin', contentBase64: bigB64 }] })).status,
      ).toBe(413)
    })
  })
})
