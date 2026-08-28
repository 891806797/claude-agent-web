import { Activity, Bot, RefreshCw } from 'lucide-react'
import { useEffect } from 'react'
import { Route, Routes } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/sonner'
import { useSystemStore } from '@/stores/system'

/**
 * 框架自验证首页：串起路由 / zustand / api 客户端 / Button / toast 全链路。
 * 业务页面请按此范式在各 route 下扩展，不在本文件堆叠。
 */
function HomePage() {
  const ready = useSystemStore((s) => s.ready)
  const loading = useSystemStore((s) => s.loading)
  const fetchReady = useSystemStore((s) => s.fetchReady)

  useEffect(() => {
    void fetchReady()
  }, [fetchReady])

  const handleRefresh = async () => {
    const ok = await fetchReady()
    if (ok) toast.success('后端服务正常')
    else toast.error('就绪检查失败')
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-xl space-y-6">
        <div className="flex items-center gap-3">
          <div className="flex size-12 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Bot className="size-6" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold text-foreground">Claude Agent Web</h1>
            <p className="text-sm text-muted-foreground">
              Bun + Hono + Drizzle 全栈模板 · 前端框架
            </p>
          </div>
        </div>

        <section className="rounded-lg border bg-card p-6 shadow-sm">
          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-medium text-card-foreground">
              <Activity className="size-4 text-muted-foreground" />
              后端就绪状态
            </div>
            <Button variant="outline" size="sm" disabled={loading} onClick={handleRefresh}>
              <RefreshCw className={loading ? 'animate-spin' : undefined} />
              刷新
            </Button>
          </div>

          <dl className="space-y-2 text-sm">
            <div className="flex gap-2">
              <dt className="w-20 shrink-0 text-muted-foreground">就绪探针</dt>
              <dd className={ready ? 'font-medium text-emerald-700' : 'font-medium text-amber-700'}>
                {loading ? '检查中…' : ready ? 'ok' : '未就绪'}
              </dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-20 shrink-0 text-muted-foreground">API 文档</dt>
              <dd className="text-card-foreground">
                <a
                  href="/docs"
                  target="_blank"
                  rel="noopener"
                  className="text-primary underline-offset-4 hover:underline"
                >
                  /docs
                </a>
              </dd>
            </div>
          </dl>
        </section>
      </div>
    </main>
  )
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
    </Routes>
  )
}
