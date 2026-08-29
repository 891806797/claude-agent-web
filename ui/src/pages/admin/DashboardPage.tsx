import { useEffect, useState } from 'react'
import { Activity, Cpu, FolderTree, Gauge, Users, Zap } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { toast } from '@/components/ui/sonner'
import { ApiError } from '@/lib/agent-api'
import { adminApi } from '@/lib/admin-api'
import type { StatsData } from '@/lib/agent-types'
import { cn } from '@/lib/utils'

/**
 * 看板大屏 —— 全局会话/用户/token 运行态。
 * 口径：
 * - 在线用户 = 当前有活跃会话的不重复 username（最严「正在使用」口径）
 * - 活跃 token = 当前所有活跃会话的 tokenUsage 累计（本进程内存态，不含历史）
 * - 历史总量/今日 = agent_session_stats 聚合
 * 10s 自动刷新。
 */
const REFRESH_MS = 10_000

const STATE_ORDER = ['idle', 'turn-running', 'starting', 'closing', 'closed'] as const
const STATE_LABEL: Record<string, string> = {
  idle: '空闲',
  'turn-running': '对话中',
  starting: '启动中',
  closing: '关闭中',
  closed: '已关闭'
}
const STATE_COLOR: Record<string, string> = {
  idle: 'bg-emerald-500',
  'turn-running': 'bg-primary',
  starting: 'bg-amber-500',
  closing: 'bg-muted-foreground',
  closed: 'bg-destructive'
}
const REASON_LABEL: Record<string, string> = {
  user_close: '用户关闭',
  idle_gc: '空闲回收',
  logout: '登出',
  evict: '被切换',
  life_limit: '寿命到限',
  shutdown: '服务停机',
  error: '错误',
  process_exit: '进程退出'
}

export function DashboardPage(): React.JSX.Element {
  const [stats, setStats] = useState<StatsData | null>(null)
  const [loading, setLoading] = useState(false)

  const fetchStats = async (): Promise<void> => {
    setLoading(true)
    try {
      setStats(await adminApi.getStats())
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : '加载统计失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void fetchStats()
    const t = setInterval(() => void fetchStats(), REFRESH_MS)
    return () => clearInterval(t)
  }, [])

  const active = stats?.active
  const hist = stats?.historical

  return (
    <main className="bg-background p-4 md:p-6">
      <header className="mb-6 flex items-center gap-3">
        <h1 className="text-xl font-semibold text-foreground">运行看板</h1>
        <Badge variant="secondary" className="gap-1">
          <span
            className={cn('size-1.5 rounded-full', loading ? 'bg-amber-500' : 'bg-emerald-500')}
          />
          {loading ? '刷新中' : `实时（${REFRESH_MS / 1000}s）`}
        </Badge>
      </header>

      {/* 顶部指标卡 */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
        <StatCard
          icon={<Activity className="size-4" />}
          label="活跃会话"
          value={active?.sessions}
        />
        <StatCard icon={<Users className="size-4" />} label="在线用户" value={active?.users} />
        <StatCard
          icon={<Zap className="size-4" />}
          label="活跃 token ↑↓"
          value={
            active ? `${fmtTok(active.inputTokens)}/${fmtTok(active.outputTokens)}` : undefined
          }
        />
        <StatCard
          icon={<Gauge className="size-4" />}
          label="今日会话"
          value={hist?.todaySessions}
        />
        <StatCard
          icon={<Cpu className="size-4" />}
          label="历史总会话"
          value={hist?.totalSessions}
        />
        <StatCard
          icon={<FolderTree className="size-4" />}
          label="项目 / 用户"
          value={stats ? `${stats.projects} / ${stats.registeredUsers}` : undefined}
        />
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        {/* 活跃会话状态分布 */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">活跃会话状态分布</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {!active || active.sessions === 0 ? (
              <p className="text-sm text-muted-foreground">当前无活跃会话</p>
            ) : (
              STATE_ORDER.map((st) => {
                const n = active.byState[st] ?? 0
                if (!n) return null
                const pct = active.sessions > 0 ? (n / active.sessions) * 100 : 0
                return (
                  <div key={st} className="flex items-center gap-2 text-xs">
                    <span className="w-16 shrink-0 text-muted-foreground">{STATE_LABEL[st]}</span>
                    <div className="h-2 flex-1 overflow-hidden rounded bg-muted">
                      <div
                        className={cn('h-full rounded', STATE_COLOR[st])}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="w-8 shrink-0 text-right text-foreground">{n}</span>
                  </div>
                )
              })
            )}
          </CardContent>
        </Card>

        {/* 在线用户排行 */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">在线用户活跃会话数</CardTitle>
          </CardHeader>
          <CardContent>
            {!active || active.byUser.length === 0 ? (
              <p className="text-sm text-muted-foreground">当前无在线用户</p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {active.byUser.map((u) => {
                  const max = active.byUser[0]?.count ?? 1
                  const pct = (u.count / max) * 100
                  return (
                    <li key={u.username} className="flex items-center gap-2 text-xs">
                      <span className="w-24 shrink-0 truncate text-foreground">{u.username}</span>
                      <div className="h-2 flex-1 overflow-hidden rounded bg-muted">
                        <div className="h-full rounded bg-primary" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="w-8 shrink-0 text-right text-muted-foreground">
                        {u.count}
                      </span>
                    </li>
                  )
                })}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* 历史关闭原因分布 */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">历史会话关闭原因分布</CardTitle>
          </CardHeader>
          <CardContent>
            {!hist || Object.keys(hist.byCloseReason).length === 0 ? (
              <p className="text-sm text-muted-foreground">暂无历史数据</p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {Object.entries(hist.byCloseReason)
                  .sort((a, b) => b[1] - a[1])
                  .map(([reason, n]) => {
                    const total = hist.totalSessions || 1
                    const pct = (n / total) * 100
                    return (
                      <li key={reason} className="flex items-center gap-2 text-xs">
                        <span className="w-20 shrink-0 text-muted-foreground">
                          {REASON_LABEL[reason] ?? reason}
                        </span>
                        <div className="h-2 flex-1 overflow-hidden rounded bg-muted">
                          <div
                            className="h-full rounded bg-foreground/60"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <span className="w-8 shrink-0 text-right text-foreground">{n}</span>
                      </li>
                    )
                  })}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* 历史累计 token */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">历史累计 token 消耗</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <TokenRow label="输入（input）" value={hist?.totalInputTokens} />
            <TokenRow label="输出（output）" value={hist?.totalOutputTokens} />
            <div className="border-t pt-2 text-xs text-muted-foreground">
              活跃会话实时：↑{fmtTok(active?.inputTokens ?? 0)} ↓{fmtTok(active?.outputTokens ?? 0)}
            </div>
          </CardContent>
        </Card>
      </div>
    </main>
  )
}

function StatCard({
  icon,
  label,
  value
}: {
  icon: React.ReactNode
  label: string
  value: string | number | undefined
}): React.JSX.Element {
  return (
    <Card>
      <CardContent className="flex flex-col gap-1 p-4">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {icon}
          {label}
        </div>
        <span className="text-2xl font-semibold text-foreground">
          {value === undefined ? '—' : value}
        </span>
      </CardContent>
    </Card>
  )
}

function TokenRow({
  label,
  value
}: {
  label: string
  value: number | undefined
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium text-foreground">
        {value === undefined ? '—' : fmtTok(value)}
      </span>
    </div>
  )
}

function fmtTok(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return String(n)
}
