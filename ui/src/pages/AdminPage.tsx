import { type ChangeEvent, type FormEvent, useEffect, useState } from 'react'
import { FolderPlus, ShieldAlert, Trash2, Users } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { toast } from '@/components/ui/sonner'
import { useAuthStore } from '@/stores/auth'
import { authApi, type UserSummary } from '@/lib/auth-api'
import { agentApi, ApiError } from '@/lib/agent-api'
import { api } from '@/lib/api'
import type { Project } from '@/lib/agent-types'

/**
 * 管理页 —— 项目目录白名单管理（CRUD）+ 用户列表/重置 MFA + 当前用户 MFA 状态/解绑。
 * 所有登录用户均可管理（决策 #25，内部工具，无角色分层）。
 */
export function AdminPage(): React.JSX.Element {
  const username = useAuthStore((s) => s.username)
  const [projects, setProjects] = useState<Project[]>([])
  const [mfaBound, setMfaBound] = useState<boolean | null>(null)
  const [users, setUsers] = useState<UserSummary[]>([])

  const refresh = (): void => {
    agentApi
      .listProjects()
      .then(setProjects)
      .catch(() => toast.error('加载项目列表失败'))
    authApi
      .listUsers()
      .then(setUsers)
      .catch(() => toast.error('加载用户列表失败'))
    if (username) {
      api
        .get<{ bound: boolean }>(`/api/auth/mfa/status?username=${encodeURIComponent(username)}`)
        .then((r) => setMfaBound(r.bound))
        .catch(() => setMfaBound(null))
    }
  }

  useEffect(refresh, [username])

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 bg-background p-6">
      <header className="flex items-center gap-3">
        <h1 className="text-xl font-semibold text-foreground">管理</h1>
        <a href="/chat" className="text-sm text-primary hover:underline">
          返回聊天
        </a>
        <a href="/dashboard" className="text-sm text-primary hover:underline">
          看板
        </a>
      </header>

      <ProjectSection projects={projects} onChanged={refresh} />
      <UserSection users={users} onChanged={refresh} />
      <MfaSection bound={mfaBound} username={username} onChanged={refresh} />
    </main>
  )
}

// ===== 项目管理 =====

function ProjectSection({
  projects,
  onChanged
}: {
  projects: Project[]
  onChanged: () => void
}): React.JSX.Element {
  const [name, setName] = useState('')
  const [path, setPath] = useState('')

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    if (!name.trim() || !path.trim()) return
    try {
      await agentApi.createProject(name.trim(), path.trim())
      setName('')
      setPath('')
      toast.success('项目已注册')
      onChanged()
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : '注册失败')
    }
  }

  const remove = async (id: string): Promise<void> => {
    try {
      await agentApi.removeProject(id)
      toast.success('项目已移除')
      onChanged()
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : '移除失败')
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <FolderPlus className="size-4" />
          项目目录
        </CardTitle>
        <CardDescription>注册 Claude 可操作的项目路径白名单（须存在于磁盘）</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <form onSubmit={submit} className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">名称</span>
            <Input
              value={name}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
              placeholder="my-project"
            />
          </label>
          <label className="flex flex-1 flex-col gap-1 text-sm">
            <span className="text-muted-foreground">路径</span>
            <Input
              value={path}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setPath(e.target.value)}
              placeholder="D:/worker/projects/demo"
            />
          </label>
          <Button type="submit" disabled={!name.trim() || !path.trim()}>
            注册
          </Button>
        </form>

        {projects.length === 0 ? (
          <p className="text-sm text-muted-foreground">尚无项目</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {projects.map((p) => (
              <li key={p.id} className="flex items-center gap-2 rounded border bg-card px-3 py-2">
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-medium text-foreground">{p.name}</span>
                  <span className="truncate text-xs text-muted-foreground">{p.path}</span>
                </div>
                <span className="text-xs text-muted-foreground">by {p.createdBy}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void remove(p.id)}
                  aria-label="移除"
                >
                  <Trash2 className="size-4 text-destructive" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

// ===== 用户管理 =====

function fmtDate(s: string | null): string {
  if (!s) return '—'
  const d = new Date(s)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  return sameDay
    ? `今天 ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
    : `${d.getMonth() + 1}/${d.getDate()}`
}

function UserSection({
  users,
  onChanged
}: {
  users: UserSummary[]
  onChanged: () => void
}): React.JSX.Element {
  const [resetting, setResetting] = useState<string | null>(null)

  const resetMfa = async (u: string): Promise<void> => {
    setResetting(u)
    try {
      await authApi.resetUserMfa(u)
      toast.success(`已重置 ${u} 的 MFA`)
      onChanged()
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : '重置失败')
    } finally {
      setResetting(null)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Users className="size-4" />
          用户（{users.length}）
        </CardTitle>
        <CardDescription>账号档案与 MFA 绑定状态；可重置他人 MFA（用户需重新绑定）</CardDescription>
      </CardHeader>
      <CardContent>
        {users.length === 0 ? (
          <p className="text-sm text-muted-foreground">暂无用户</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {users.map((u) => (
              <li
                key={u.username}
                className="flex items-center gap-2 rounded border bg-card px-3 py-2 text-sm"
              >
                <span className="min-w-0 flex-1">
                  <span className="font-medium text-foreground">{u.username}</span>
                  <span className="ml-2 text-xs text-muted-foreground">
                    登录 {fmtDate(u.lastLoginAt)}
                  </span>
                </span>
                {u.mfaBoundAt ? (
                  <Badge variant="secondary">MFA 已绑定</Badge>
                ) : (
                  <Badge variant="outline">未绑定</Badge>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={resetting === u.username || !u.mfaBoundAt}
                  onClick={() => void resetMfa(u.username)}
                >
                  重置 MFA
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

// ===== MFA 管理 =====

function MfaSection({
  bound,
  username,
  onChanged
}: {
  bound: boolean | null
  username: string
  onChanged: () => void
}): React.JSX.Element {
  const [password, setPassword] = useState('')
  const [token, setToken] = useState('')

  const unbind = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    try {
      await api.post('/api/auth/mfa/unbind', {
        username,
        password,
        ...(token.trim() ? { token: token.trim() } : {})
      })
      setPassword('')
      setToken('')
      toast.success('MFA 已解绑')
      onChanged()
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : '解绑失败')
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldAlert className="size-4" />
          MFA
        </CardTitle>
        <CardDescription>当前账号的多因素认证状态</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">状态：</span>
          {bound === null ? (
            <Badge variant="secondary">未知</Badge>
          ) : bound ? (
            <Badge>已绑定</Badge>
          ) : (
            <Badge variant="outline">未绑定</Badge>
          )}
        </div>
        {bound && (
          <form onSubmit={unbind} className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted-foreground">密码（必填）</span>
              <Input
                type="password"
                value={password}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setPassword(e.target.value)}
                required
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted-foreground">动态码（可选）</span>
              <Input
                value={token}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setToken(e.target.value)}
                placeholder="6 位动态码"
              />
            </label>
            <Button type="submit" variant="destructive" disabled={!password}>
              解绑
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  )
}
