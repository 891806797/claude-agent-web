import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { type SetURLSearchParams, useSearchParams } from 'react-router-dom'
import { BookOpenIcon, PanelLeft, PanelRight } from 'lucide-react'
import { ChatLayout } from '@/components/chat/ChatLayout'
import { CostCircle } from '@/components/chat/CostCircle'
import { FileTree } from '@/components/chat/FileTree'
import { SessionListPanel } from '@/components/chat/SessionListPanel'
import { UsageGuide } from '@/components/chat/UsageGuide'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { toast } from '@/components/ui/sonner'
import { useAuthStore } from '@/stores/auth'
import { useChatAgentApi } from '@/hooks/useChatAgentApi'
import { useIsMobile } from '@/hooks/useIsMobile'
import { agentApi, encodeDir, ApiError } from '@/lib/agent-api'
import type { OccupiedInfo, Project, SessionCloseReason, SessionSummary } from '@/lib/agent-types'
import { cn } from '@/lib/utils'

export function ChatPage(): React.JSX.Element {
  const [projects, setProjects] = useState<Project[]>([])
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [params, setParams] = useSearchParams()
  const [hydrated, setHydrated] = useState(false)
  const [refreshNonce, setRefreshNonce] = useState(0)
  const isMobile = useIsMobile()
  const me = useAuthStore((s) => s.username)

  const agent = useChatAgentApi({ projectId: selectedProjectId })

  // ===== 会话终结横幅（query_closed 后提示去向） =====
  const closed: { reason: SessionCloseReason } | null = agent.closed

  // ===== 侧栏刷新信号：status 回到 idle 后 400ms 防抖（回复完成/会话空闲时重拉列表） =====
  const prevStatusRef = useRef(agent.status)
  useEffect(() => {
    const was = prevStatusRef.current
    prevStatusRef.current = agent.status
    if (was !== 'idle' && agent.status === 'idle') {
      const t = setTimeout(() => setRefreshNonce((n) => n + 1), 400)
      return () => clearTimeout(t)
    }
  }, [agent.status])

  // ===== 项目列表 =====
  useEffect(() => {
    agentApi
      .listProjects()
      .then(setProjects)
      .catch(() => toast.error('加载项目列表失败'))
  }, [])

  // ===== 占用接管确认（AGENT_SESSION_BUSY 409 → details.occupiedBy） =====
  const [evictPending, setEvictPending] = useState<{
    occupiedBy: OccupiedInfo
    retry: (evict: boolean) => Promise<void>
  } | null>(null)

  /** 开会话/恢复统一入口：409 占用按占用者分流——同人静默接管（自己旧会话，历史可恢复），异人弹确认 */
  const openSession = useCallback(
    async (fn: (evict?: boolean) => Promise<void>): Promise<void> => {
      try {
        await fn()
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          const occ = extractOccupied(err.details)
          if (occ) {
            if (occ.username === me) {
              try {
                await fn(true)
              } catch (retryErr) {
                toast.error(retryErr instanceof ApiError ? retryErr.message : '接管失败')
              }
              return
            }
            setEvictPending({ occupiedBy: occ, retry: fn })
            return
          }
        }
        toast.error(err instanceof ApiError ? err.message : '操作失败')
      }
    },
    [me]
  )

  // ===== URL 恢复（?ws=&sid=）：attach 活跃会话 → resume 兜底 =====
  const attachExisting = agent.attachExisting
  const resumeSession = agent.resumeSession
  useEffect(() => {
    if (hydrated || projects.length === 0) return
    const wsParam = params.get('ws')
    const sidParam = params.get('sid')
    setHydrated(true)
    if (!wsParam || !sidParam) return
    const matched = projects.find((p) => encodeDir(p.path) === wsParam)
    if (!matched) {
      toast.error('项目未注册或已被移除')
      return
    }
    setSelectedProjectId(matched.id)
    void (async () => {
      try {
        const attached = await attachExisting(matched.path, sidParam)
        if (!attached) await resumeSession(sidParam, matched.id)
        syncUrl(params, setParams, matched.path, sidParam)
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          const occ = extractOccupied(err.details)
          if (occ) {
            const retry = (evict: boolean): Promise<void> =>
              resumeSession(sidParam, matched.id, evict).then(() => {
                syncUrl(params, setParams, matched.path, sidParam)
              })
            // 同人占用：静默接管（同 openSession 分流逻辑）
            if (occ.username === me) {
              try {
                await retry(true)
              } catch {
                toast.error('恢复会话失败')
              }
              return
            }
            setEvictPending({ occupiedBy: occ, retry })
            return
          }
        }
        toast.error(err instanceof ApiError ? err.message : '恢复会话失败')
      }
    })()
  }, [projects, params, hydrated, attachExisting, resumeSession, me])

  // ===== 侧栏回调 =====
  // 移动端左抽屉开合提升至此：会话选定/新建后由此统一收起
  const [mobileLeftOpen, setMobileLeftOpen] = useState(false)

  const handleNewSession = useCallback(
    (project: Project) => {
      setMobileLeftOpen(false)
      setSelectedProjectId(project.id)
      void openSession(async (evict) => {
        const outcome = await agent.openNewSession(project.id, evict)
        // null：请求期间被更新的会话操作取代，URL 由取代者负责
        if (outcome) {
          syncUrl(params, setParams, outcome.workspaceDir, outcome.sessionId)
          // 占位会话已落盘：立即重拉列表让"新会话"条目上屏（不等回复结束的防抖刷新）
          setRefreshNonce((n) => n + 1)
        }
      })
    },
    [openSession, agent, params, setParams]
  )

  const handleResumeSession = useCallback(
    (session: SessionSummary, projectPath: string) => {
      setMobileLeftOpen(false)
      // 点击当前已连接会话：no-op（重开将自我 409 占用冲突）
      if (session.id === agent.sessionId) return
      const project = projects.find((p) => p.path === projectPath)
      if (!project) {
        toast.error('项目不存在或已移除')
        return
      }
      setSelectedProjectId(project.id)
      void openSession(async (evict) => {
        await agent.resumeSession(session.id, project.id, evict)
        syncUrl(params, setParams, project.path, session.id)
        // resume 即激活（进程起、ctx 入注册表）：立即重拉列表点亮 live 绿点，
        // 否则要等首条消息回复结束的防抖刷新才显示
        setRefreshNonce((n) => n + 1)
      })
    },
    [projects, openSession, agent, params, setParams]
  )

  /** 彻底关闭当前会话（左侧会话条目入口）：后端终止进程/清 SessionContext，前端断 SSE 清消息；
   *  URL 残留 ws/sid 会让刷新自动恢复刚关的会话，一并清除；bump 刷新让列表 live 点消失 */
  const handleCloseSession = useCallback(() => {
    agent.closeRun()
    setRefreshNonce((n) => n + 1)
    if (params.has('ws') || params.has('sid')) {
      const next = new URLSearchParams(params)
      next.delete('ws')
      next.delete('sid')
      setParams(next, { replace: true })
    }
  }, [agent, params, setParams])

  const handleDeleteSession = useCallback(
    async (session: SessionSummary, projectPath: string) => {
      try {
        await agentApi.deleteSession(session.id, projectPath)
        if (agent.sessionId === session.id) agent.closeRun()
        setRefreshNonce((n) => n + 1)
        toast.success('会话已删除')
      } catch (err) {
        toast.error(err instanceof ApiError ? err.message : '删除会话失败')
      }
    },
    [agent]
  )

  const handleRenameSession = useCallback(
    async (sid: string, projectPath: string, title: string) => {
      try {
        await agentApi.renameSession(sid, projectPath, title)
        setRefreshNonce((n) => n + 1)
      } catch (err) {
        toast.error(err instanceof ApiError ? err.message : '重命名失败')
      }
    },
    []
  )

  const handleAddProject = useCallback(async (name: string, path: string) => {
    try {
      await agentApi.createProject(name, path)
      setProjects(await agentApi.listProjects())
      toast.success('项目已添加')
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : '添加失败')
    }
  }, [])

  const handleRemoveProject = useCallback(
    async (project: Project) => {
      try {
        await agentApi.removeProject(project.id)
        if (selectedProjectId === project.id) {
          setSelectedProjectId(null)
          agent.closeRun()
        }
        setProjects(await agentApi.listProjects())
        setRefreshNonce((n) => n + 1)
        toast.success('项目已移除')
      } catch (err) {
        toast.error(err instanceof ApiError ? err.message : '移除失败')
      }
    },
    [selectedProjectId, agent]
  )

  // ===== 指南弹窗 =====
  const [guideOpen, setGuideOpen] = useState(false)

  // ===== 中栏内容：绑定则聊天，未绑定则引导空态（切换中保持聊天防闪空态） =====
  const bound = agent.sessionId !== null || agent.isSwitchingSession
  const chatNode: ReactNode = bound ? (
    <ChatLayout agent={agent} />
  ) : (
    <div className="h-full min-h-0 flex flex-col bg-[var(--bg-base)] rounded-[10px] overflow-hidden shadow-[var(--elevation-raised)] m-2">
      <UsageGuide />
    </div>
  )

  const sidebarNode: ReactNode = (
    <SessionListPanel
      projects={projects}
      selectedProjectId={selectedProjectId}
      currentSessionId={agent.sessionId}
      refreshNonce={refreshNonce}
      onNewSession={handleNewSession}
      onResumeSession={handleResumeSession}
      onCloseSession={handleCloseSession}
      onRequestDeleteSession={handleDeleteSession}
      onRenameSession={(sid, path, title) => void handleRenameSession(sid, path, title)}
      onAddProject={handleAddProject}
      onRequestRemoveProject={handleRemoveProject}
    />
  )
  const detailNode: ReactNode = <FileTree projectId={selectedProjectId} />

  const title = projects.find((p) => p.id === selectedProjectId)?.name ?? 'Claude Code'

  const evictDialog = <EvictDialog pending={evictPending} onClose={() => setEvictPending(null)} />

  if (isMobile)
    return (
      <>
        <MobileLayout
          title={title}
          agent={agent}
          closed={closed}
          guide={{ guideOpen, setGuideOpen }}
          sidebar={sidebarNode}
          detail={detailNode}
          chat={chatNode}
          leftOpen={mobileLeftOpen}
          onLeftOpenChange={setMobileLeftOpen}
        />
        {evictDialog}
      </>
    )
  return (
    <>
      <DesktopLayout
        title={title}
        agent={agent}
        closed={closed}
        guide={{ guideOpen, setGuideOpen }}
        sidebar={sidebarNode}
        detail={detailNode}
        chat={chatNode}
      />
      {evictDialog}
    </>
  )
}

/** 会话位被他人占用（AGENT_SESSION_BUSY）：确认后 evict=true 接管（断开对方） */
function EvictDialog({
  pending,
  onClose
}: {
  pending: { occupiedBy: OccupiedInfo; retry: (evict: boolean) => Promise<void> } | null
  onClose: () => void
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const occ = pending?.occupiedBy
  const idle = occ && occ.idleMinutes > 0 ? `（${occ.idleMinutes} 分钟前活跃）` : ''
  return (
    <Dialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogContent hideClose className="max-w-[400px]">
        <DialogHeader>
          <DialogTitle>会话位被占用</DialogTitle>
          <DialogDescription>
            {occ ? `${occ.username} 正在使用该项目的会话位${idle}。` : ''}
            接管将断开对方的会话连接，是否继续？
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" size="sm" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={busy}
            onClick={() => {
              if (!pending) return
              setBusy(true)
              void pending
                .retry(true)
                .catch((err: unknown) => {
                  toast.error(err instanceof ApiError ? err.message : '接管失败')
                })
                .finally(() => {
                  setBusy(false)
                  onClose()
                })
            }}
          >
            {busy ? '接管中…' : '接管会话'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ═══════════════ 桌面三栏（可拖拽 180-420 / 260-⅔窗宽，越中线收左栏） ═══════════════

function DesktopLayout(props: {
  title: string
  agent: ReturnType<typeof useChatAgentApi>
  closed: { reason: SessionCloseReason } | null
  guide: { guideOpen: boolean; setGuideOpen: (v: boolean) => void }
  sidebar: ReactNode
  detail: ReactNode
  chat: ReactNode
}): React.JSX.Element {
  const { title, agent, closed, guide, sidebar, detail, chat } = props
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [detailOpen, setDetailOpen] = useState(true)
  const [sidebarWidth, setSidebarWidth] = useState(260)
  const [detailWidth, setDetailWidth] = useState(320)
  const [resizing, setResizing] = useState<'sidebar' | 'detail' | null>(null)
  const [windowWidth, setWindowWidth] = useState(() => window.innerWidth)

  const startWidthRef = useRef(0)
  const startXRef = useRef(0)
  // 因空间不足被自动折叠的面板：窗口变宽时自动恢复（用户手动折叠的不受影响）
  const autoHidden = useRef({ sidebar: false, detail: false })

  // 宽度自适应：中栏保底 480px（web 无 desktop Electron 的 minWidth 保护，需自行钳制）
  const MIN_CHAT_WIDTH = 480
  const sidebarCost = sidebarOpen ? sidebarWidth + 4 : 6
  // 右侧宽度上限 = 窗宽 - 左栏 - 中栏下限（保留下限 260）；越过窗口中线折叠左侧
  const detailMax = Math.max(260, windowWidth - MIN_CHAT_WIDTH - sidebarCost - 4)
  const halfWindow = windowWidth / 2

  useEffect(() => {
    const onResize = (): void => setWindowWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // 宽度自适应：① 右栏钳制在动态上限内（缩窗后收窄）② 预算不足按「先文件树后侧栏」
  // 自动折叠并标记 ③ 窗口变宽后仅恢复被自动折叠者。拖拽中让位（放手后此 effect 兜底）
  useEffect(() => {
    if (resizing) return
    const budget = windowWidth - MIN_CHAT_WIDTH
    const detailCost = detailOpen ? detailWidth + 4 : 6
    if (detailOpen && sidebarCost + detailCost > budget) {
      autoHidden.current.detail = true
      setDetailOpen(false)
      return
    }
    if (sidebarOpen && sidebarWidth + 4 + detailCost > budget) {
      autoHidden.current.sidebar = true
      setSidebarOpen(false)
      return
    }
    if (autoHidden.current.detail && !detailOpen && sidebarCost + detailWidth + 4 <= budget) {
      autoHidden.current.detail = false
      setDetailOpen(true)
      return
    }
    if (
      autoHidden.current.sidebar &&
      !sidebarOpen &&
      sidebarWidth + 4 + (detailOpen ? detailWidth + 4 : 6) <= budget
    ) {
      autoHidden.current.sidebar = false
      setSidebarOpen(true)
    }
    setDetailWidth((prev) => (prev > detailMax ? detailMax : prev))
  }, [
    windowWidth,
    sidebarWidth,
    detailWidth,
    sidebarOpen,
    detailOpen,
    sidebarCost,
    detailMax,
    resizing
  ])

  // 手动开合：展开时若预算不足先让对侧自动让位（保中栏下限，手动操作永远生效）
  const toggleSidebar = useCallback(
    (open: boolean) => {
      if (
        open &&
        !sidebarOpen &&
        detailOpen &&
        sidebarWidth + 4 + detailWidth + 4 > windowWidth - MIN_CHAT_WIDTH
      ) {
        autoHidden.current.detail = true
        setDetailOpen(false)
      }
      autoHidden.current.sidebar = false
      setSidebarOpen(open)
    },
    [sidebarOpen, detailOpen, sidebarWidth, detailWidth, windowWidth]
  )

  const toggleDetail = useCallback(
    (open: boolean) => {
      if (
        open &&
        !detailOpen &&
        sidebarOpen &&
        sidebarWidth + 4 + detailWidth + 4 > windowWidth - MIN_CHAT_WIDTH
      ) {
        autoHidden.current.sidebar = true
        setSidebarOpen(false)
      }
      autoHidden.current.detail = false
      setDetailOpen(open)
    },
    [sidebarOpen, detailOpen, sidebarWidth, detailWidth, windowWidth]
  )

  const beginResize = useCallback(
    (which: 'sidebar' | 'detail', startX: number) => {
      startWidthRef.current = which === 'sidebar' ? sidebarWidth : detailWidth
      startXRef.current = startX
      setResizing(which)
    },
    [sidebarWidth, detailWidth]
  )

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (resizing == null) return
      const delta = e.clientX - startXRef.current
      if (resizing === 'sidebar') {
        // 上限同时受窗宽约束（拖拽本身不得挤压中栏下限；不足时被夹在 180，放手后自适应 effect 折叠对侧）
        const detailCost = detailOpen ? detailWidth + 4 : 6
        const widthCap = Math.min(420, windowWidth - MIN_CHAT_WIDTH - detailCost)
        setSidebarWidth(Math.max(180, Math.min(widthCap, startWidthRef.current + delta)))
      } else {
        const next = Math.max(260, Math.min(detailMax, startWidthRef.current - delta))
        setDetailWidth(next)
        // 右侧越过窗口中线 -> 自动折叠左侧（单向：拖回不自动展开）
        if (next > halfWindow) setSidebarOpen(false)
      }
    },
    [resizing, detailMax, halfWindow, detailOpen, detailWidth, windowWidth]
  )

  const endResize = useCallback(() => setResizing(null), [])
  const dragging = resizing != null

  return (
    <div
      className={['h-dvh flex bg-[var(--bg-deep)]', dragging && 'cursor-col-resize select-none']
        .filter(Boolean)
        .join(' ')}
      onMouseMove={handleMouseMove}
      onMouseUp={endResize}
      onMouseLeave={() => {
        if (dragging) endResize()
      }}
    >
      {/* 左侧会话面板 */}
      <div
        className={[
          'h-full flex flex-col bg-[var(--bg-layer-01)] shrink-0 overflow-hidden',
          'transition-[width] duration-200 ease-out',
          sidebarOpen ? 'border-r border-[var(--border-muted)]' : ''
        ].join(' ')}
        style={{
          width: sidebarOpen ? sidebarWidth : 0,
          transition: resizing === 'sidebar' ? 'none' : undefined
        }}
      >
        <div className="h-full" style={{ width: sidebarWidth }}>
          {sidebar}
        </div>
      </div>

      {sidebarOpen ? (
        <Handle
          active={resizing === 'sidebar'}
          side="left"
          onMouseDown={(e) => beginResize('sidebar', e.clientX)}
        />
      ) : (
        <ToggleEdge side="left" onClick={() => toggleSidebar(true)} />
      )}

      {/* 中间聊天区域 */}
      <div className="flex-1 min-w-0 h-full flex flex-col bg-[var(--bg-deep)]">
        <div className="h-9 flex items-center justify-between px-2 shrink-0">
          <div className="flex items-center gap-1 min-w-0">
            {sidebarOpen ? (
              <CollapseBtn
                icon="panel-left"
                label="隐藏侧栏"
                onClick={() => toggleSidebar(false)}
              />
            ) : (
              <CollapseBtn
                icon="panel-left-open"
                label="展开侧栏"
                onClick={() => toggleSidebar(true)}
              />
            )}
            <span className="text-[12px] text-[var(--text-muted)] truncate ml-1" title={title}>
              {title}
            </span>
          </div>
          <CostCircle agent={agent} />
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => guide.setGuideOpen(true)}
              title="使用指南"
              className="size-7 flex items-center justify-center rounded-md text-[var(--text-faint)] hover:text-[var(--text-base)] hover:bg-[var(--overlay-hover)] transition-colors duration-100 cursor-pointer"
            >
              <BookOpenIcon className="size-[15px]" />
            </button>
            {detailOpen ? (
              <CollapseBtn
                icon="panel-right"
                label="隐藏文件面板"
                onClick={() => toggleDetail(false)}
              />
            ) : (
              <CollapseBtn
                icon="panel-right-open"
                label="展开文件面板"
                onClick={() => toggleDetail(true)}
              />
            )}
          </div>
        </div>
        {closed && <ClosedBanner reason={closed.reason} />}
        {chat}
      </div>

      {/* 右侧文件树面板 */}
      {detailOpen ? (
        <Handle
          active={resizing === 'detail'}
          side="right"
          onMouseDown={(e) => beginResize('detail', e.clientX)}
        />
      ) : (
        <ToggleEdge side="right" onClick={() => toggleDetail(true)} />
      )}

      <div
        className={[
          'h-full flex flex-col bg-[var(--bg-layer-01)] shrink-0 overflow-hidden',
          'transition-[width] duration-200 ease-out',
          detailOpen ? 'border-l border-[var(--border-muted)]' : ''
        ].join(' ')}
        style={{
          width: detailOpen ? detailWidth : 0,
          transition: resizing === 'detail' ? 'none' : undefined
        }}
      >
        <div className="h-full" style={{ width: detailWidth }}>
          {detail}
        </div>
      </div>

      <GuideDialog open={guide.guideOpen} onOpenChange={guide.setGuideOpen} />
    </div>
  )
}

// ═══════════════ 移动布局（<768px：中栏满宽 + 左右覆盖抽屉） ═══════════════

function MobileLayout(props: {
  title: string
  agent: ReturnType<typeof useChatAgentApi>
  closed: { reason: SessionCloseReason } | null
  guide: { guideOpen: boolean; setGuideOpen: (v: boolean) => void }
  sidebar: ReactNode
  detail: ReactNode
  chat: ReactNode
  /** 左抽屉开合受控于 ChatPage（会话选定/新建后统一收起） */
  leftOpen: boolean
  onLeftOpenChange: (v: boolean) => void
}): React.JSX.Element {
  const { title, agent, closed, guide, sidebar, detail, chat, leftOpen, onLeftOpenChange } = props
  const [rightOpen, setRightOpen] = useState(false)

  // 文件树注入 @chip 后收起右抽屉（复用 composer:insert 事件通道，无需 prop 钻透）
  useEffect(() => {
    const onInsert = (): void => setRightOpen(false)
    window.addEventListener('composer:insert', onInsert)
    return () => window.removeEventListener('composer:insert', onInsert)
  }, [])

  return (
    <div className="h-dvh flex flex-col bg-[var(--bg-deep)] overflow-hidden">
      {/* 顶栏：抽屉钮 + 标题 + 用量/指南/文件树 */}
      <header className="h-11 flex items-center justify-between px-2 shrink-0">
        <button
          type="button"
          onClick={() => onLeftOpenChange(true)}
          className="size-8 flex items-center justify-center rounded-md text-[var(--text-faint)] hover:text-[var(--text-base)] hover:bg-[var(--overlay-hover)] transition-colors"
          aria-label="项目与会话"
        >
          <PanelLeft className="size-4" />
        </button>
        <span className="text-[13px] font-medium text-[var(--text-base)] truncate px-2">
          {title}
        </span>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => guide.setGuideOpen(true)}
            className="size-8 flex items-center justify-center rounded-md text-[var(--text-faint)] hover:text-[var(--text-base)] hover:bg-[var(--overlay-hover)] transition-colors"
            aria-label="使用指南"
          >
            <BookOpenIcon className="size-4" />
          </button>
          <CostCircle agent={agent} />
          <button
            type="button"
            onClick={() => setRightOpen(true)}
            className="size-8 flex items-center justify-center rounded-md text-[var(--text-faint)] hover:text-[var(--text-base)] hover:bg-[var(--overlay-hover)] transition-colors"
            aria-label="文件树"
          >
            <PanelRight className="size-4" />
          </button>
        </div>
      </header>
      {closed && <ClosedBanner reason={closed.reason} />}
      <div className="flex-1 min-h-0">{chat}</div>

      {/* 左抽屉：项目与会话（选完自动关） */}
      <Drawer open={leftOpen} side="left" onClose={() => onLeftOpenChange(false)}>
        {sidebar}
      </Drawer>
      {/* 右抽屉：文件树 */}
      <Drawer open={rightOpen} side="right" onClose={() => setRightOpen(false)}>
        {detail}
      </Drawer>

      <GuideDialog open={guide.guideOpen} onOpenChange={guide.setGuideOpen} />
    </div>
  )
}

/** 抽屉覆盖层：backdrop + translate-x 滑出（移动端宽 85vw / 最大 320px） */
function Drawer({
  open,
  side,
  onClose,
  children
}: {
  open: boolean
  side: 'left' | 'right'
  onClose: () => void
  children: ReactNode
}): React.JSX.Element {
  return (
    <>
      <div
        className={cn(
          'fixed inset-0 z-30 bg-black/25 transition-opacity duration-200',
          open ? 'opacity-100' : 'opacity-0 pointer-events-none'
        )}
        onClick={onClose}
      />
      <div
        className={cn(
          'fixed inset-y-0 z-40 w-[85vw] max-w-[320px] h-full bg-[var(--bg-layer-01)] shadow-lg transition-transform duration-200',
          side === 'left' ? 'left-0' : 'right-0',
          open ? 'translate-x-0' : side === 'left' ? '-translate-x-full' : 'translate-x-full'
        )}
      >
        {children}
      </div>
    </>
  )
}

// ═══════════════ 公共小组件 ═══════════════

function ClosedBanner({ reason }: { reason: SessionCloseReason }): React.JSX.Element {
  return (
    <div className="shrink-0 px-4 py-1.5 text-center text-[11px] text-[var(--text-faint)] bg-[var(--bg-layer-01)] border-y border-[var(--border-muted)]">
      会话已关闭（{reasonLabel(reason)}）— 刷新页面或从左侧恢复历史
    </div>
  )
}

function GuideDialog({
  open,
  onOpenChange
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
}): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
        <div className="min-h-0 flex-1 overflow-auto">
          <UsageGuide />
        </div>
      </DialogContent>
    </Dialog>
  )
}

function Handle({
  active,
  side,
  onMouseDown
}: {
  active: boolean
  side?: 'left' | 'right'
  onMouseDown: (e: React.MouseEvent) => void
}): React.JSX.Element {
  // 命中放大层只向「中间聊天区」方向扩展，避免覆盖相邻侧栏的滚动条
  const hitClass =
    side === 'left'
      ? 'absolute inset-y-0 left-0 -right-[6px]'
      : side === 'right'
        ? 'absolute inset-y-0 -left-[6px] right-0'
        : 'absolute inset-y-0 -left-[6px] -right-[6px]'
  return (
    <div className="shrink-0 w-[4px] h-full relative cursor-col-resize" onMouseDown={onMouseDown}>
      <div className={hitClass} onMouseDown={onMouseDown} />
      <div
        className={[
          'absolute inset-y-0 left-1/2 -translate-x-1/2 w-[1px] rounded-full transition-colors duration-200',
          active ? 'bg-primary scale-x-[3]' : ''
        ].join(' ')}
      />
    </div>
  )
}

/** 面板收起后的边缘触发条 */
function ToggleEdge({
  side,
  onClick
}: {
  side: 'left' | 'right'
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      title={side === 'left' ? '展开会话面板' : '展开文件面板'}
      className={[
        'shrink-0 w-[6px] h-full cursor-e-resize transition-colors duration-150',
        'hover:bg-[var(--overlay-hover)]',
        side === 'left' ? 'rounded-r' : 'rounded-l'
      ].join(' ')}
    />
  )
}

function CollapseBtn({
  icon,
  label,
  onClick
}: {
  icon: string
  label: string
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      title={label}
      className="size-7 flex items-center justify-center rounded-md text-[var(--text-faint)] hover:text-[var(--text-base)] hover:bg-[var(--overlay-hover)] transition-colors duration-100"
    >
      <PanelIcon name={icon} />
    </button>
  )
}

function PanelIcon({ name }: { name: string }): React.JSX.Element | null {
  switch (name) {
    case 'panel-left':
      return (
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <line x1="9" y1="3" x2="9" y2="21" />
          <line x1="13" y1="12" x2="17" y2="12" />
        </svg>
      )
    case 'panel-left-open':
      return (
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <line x1="9" y1="3" x2="9" y2="21" />
          <line x1="14" y1="12" x2="17" y2="12" />
        </svg>
      )
    case 'panel-right':
      return (
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <line x1="15" y1="3" x2="15" y2="21" />
          <line x1="7" y1="12" x2="11" y2="12" />
        </svg>
      )
    case 'panel-right-open':
      return (
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <line x1="15" y1="3" x2="15" y2="21" />
          <line x1="10" y1="12" x2="13" y2="12" />
        </svg>
      )
    default:
      return null
  }
}

// ═══════════════ 纯函数 ═══════════════

function syncUrl(
  params: URLSearchParams,
  setParams: SetURLSearchParams,
  ws: string,
  sid: string
): void {
  const next = new URLSearchParams(params)
  next.set('ws', encodeDir(ws))
  next.set('sid', sid)
  setParams(next, { replace: true })
}

function reasonLabel(reason: SessionCloseReason): string {
  const map: Record<string, string> = {
    user_close: '已手动关闭',
    idle_gc: '空闲回收',
    logout: '登出',
    evict: '被切换',
    life_limit: '到达寿命上限',
    shutdown: '服务停机',
    error: '错误',
    process_exit: '进程退出'
  }
  return map[reason] ?? reason
}

/** 从 ApiError.details 解析 occupiedBy（AGENT_SESSION_BUSY 契约：details.occupiedBy） */
function extractOccupied(details: unknown): OccupiedInfo | null {
  if (details && typeof details === 'object' && 'occupiedBy' in details) {
    const occ = (details as { occupiedBy: OccupiedInfo }).occupiedBy
    if (occ && typeof occ === 'object' && typeof occ.username === 'string') return occ
  }
  return null
}
