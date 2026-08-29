import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Check,
  Folder,
  LayoutDashboard,
  MessageSquare,
  MoreVertical,
  Pencil,
  Plus,
  RefreshCw,
  Settings,
  Trash2,
  X
} from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { agentApi } from '@/lib/agent-api'
import type { Project, SessionSummary } from '@/lib/agent-types'

function fmtTime(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}分钟前`
  const sameDay = d.toDateString() === new Date().toDateString()
  return sameDay
    ? `今天 ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
    : `${d.getMonth() + 1}/${d.getDate()}`
}

export interface SessionListPanelProps {
  projects: Project[]
  selectedProjectId: string | null
  currentSessionId: string | null
  /** 侧栏刷新信号（turn 结束防抖递增）；面板内手动刷新也会 bump 本地副本 */
  refreshNonce: number
  onNewSession: (project: Project) => void
  onResumeSession: (session: SessionSummary, projectPath: string) => void
  /** 彻底关闭当前会话（终止 CLI 进程 + 断 SSE + 清 SessionContext/前端消息，历史保留可再恢复） */
  onCloseSession: () => void
  /** 确认删除后由 ChatPage 执行 API（删当前会话需联动 closeSession） */
  onRequestDeleteSession: (session: SessionSummary, projectPath: string) => Promise<void>
  onRenameSession: (sid: string, projectPath: string, title: string) => void
  onAddProject: (name: string, path: string) => Promise<void>
  /** 确认移除后由 ChatPage 执行 API 并刷新项目列表 */
  onRequestRemoveProject: (project: Project) => Promise<void>
}

export function SessionListPanel(props: SessionListPanelProps): React.JSX.Element {
  const {
    projects,
    selectedProjectId,
    currentSessionId,
    refreshNonce,
    onNewSession,
    onResumeSession,
    onCloseSession,
    onRequestDeleteSession,
    onRenameSession,
    onAddProject,
    onRequestRemoveProject
  } = props
  const navigate = useNavigate()

  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [addOpen, setAddOpen] = useState(false)
  /** 手动刷新信号（与外部 refreshNonce 合流：两者相加驱动重拉） */
  const [localNonce, setLocalNonce] = useState(0)
  /** 待确认删除（null = 弹窗关闭） */
  const [pendingDelete, setPendingDelete] = useState<
    | { type: 'session'; session: SessionSummary; projectPath: string }
    | { type: 'project'; project: Project }
    | null
  >(null)
  const [deleting, setDeleting] = useState(false)

  // 首个项目自动展开（无选中时的落点）
  useEffect(() => {
    if (expanded.size === 0 && projects.length > 0) {
      setExpanded(new Set([selectedProjectId ?? projects[0]!.id]))
    }
  }, [projects.length])

  const toggleProject = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  // 创建会话：先展开目标项目，会话列表随占位落盘（refreshNonce）到达即上屏并高亮选中
  const handleNewSession = useCallback(
    (project: Project) => {
      setExpanded((prev) => {
        if (prev.has(project.id)) return prev
        const next = new Set(prev)
        next.add(project.id)
        return next
      })
      onNewSession(project)
    },
    [onNewSession]
  )

  // 当前项目置顶，其余保持后端顺序
  const sortedProjects = useMemo(() => {
    const current = projects.find((p) => p.id === selectedProjectId)
    const rest = projects.filter((p) => p.id !== selectedProjectId)
    return current ? [current, ...rest] : rest
  }, [projects, selectedProjectId])

  const handleConfirmDelete = useCallback(async () => {
    if (!pendingDelete) return
    setDeleting(true)
    try {
      if (pendingDelete.type === 'session') {
        await onRequestDeleteSession(pendingDelete.session, pendingDelete.projectPath)
      } else {
        await onRequestRemoveProject(pendingDelete.project)
      }
      setPendingDelete(null)
      setLocalNonce((n) => n + 1) // 触发重拉列表
    } finally {
      setDeleting(false)
    }
  }, [pendingDelete, onRequestDeleteSession, onRequestRemoveProject])

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between px-3 py-3 border-b border-[var(--border-muted)] shrink-0">
        <h2 className="text-[12px] font-semibold tracking-[0.18em] text-[var(--text-muted)]">
          项目
        </h2>
        <div className="flex items-center gap-0.5">
          <button
            onClick={() => setLocalNonce((n) => n + 1)}
            className="size-6 flex items-center justify-center rounded-md transition-colors hover:bg-[var(--overlay-hover)] text-[var(--text-muted)] hover:text-[var(--text-base)]"
            title="刷新"
          >
            <RefreshCw className="size-3.5" />
          </button>
          <button
            onClick={() => setAddOpen(true)}
            className="size-6 flex items-center justify-center rounded-md transition-colors hover:bg-[var(--overlay-hover)] text-[var(--text-muted)] hover:text-[var(--text-base)]"
            title="添加项目"
          >
            <Plus className="size-4" />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto py-1">
        {projects.length === 0 && (
          <div className="flex flex-col items-center gap-2 px-3 py-10 text-center">
            <Folder className="size-7 text-[var(--text-faint)] opacity-50" />
            <p className="text-[13px] text-[var(--text-faint)]">暂无项目</p>
            <p className="text-[11px] text-[var(--text-faint)]">点击右上 + 添加项目</p>
          </div>
        )}
        {sortedProjects.map((p) => (
          <ProjectGroup
            key={p.id}
            project={p}
            expanded={expanded.has(p.id)}
            refreshTick={refreshNonce + localNonce}
            currentSessionId={currentSessionId}
            onToggle={() => toggleProject(p.id)}
            onNewSession={handleNewSession}
            onResumeSession={onResumeSession}
            onCloseSession={onCloseSession}
            onDeleteSession={setPendingDelete}
            onRenameSession={onRenameSession}
            onRemoveProject={setPendingDelete}
          />
        ))}
      </div>

      <div className="shrink-0 border-t border-[var(--border-muted)] p-2 flex flex-col gap-0.5">
        <button
          onClick={() => navigate('/admin/dashboard')}
          className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-[13px] text-[var(--text-muted)] hover:text-[var(--text-base)] hover:bg-[var(--overlay-hover)] transition-colors"
          title="管理"
        >
          <LayoutDashboard className="shrink-0 size-3.5" />
          管理
        </button>
        <button
          onClick={() => navigate('/admin/settings')}
          className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-[13px] text-[var(--text-muted)] hover:text-[var(--text-base)] hover:bg-[var(--overlay-hover)] transition-colors"
          title="设置"
        >
          <Settings className="shrink-0 size-3.5" />
          设置
        </button>
      </div>

      <AddProjectDialog open={addOpen} onOpenChange={setAddOpen} onAdd={onAddProject} />

      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open && !deleting) setPendingDelete(null)
        }}
      >
        <DialogContent hideClose className="max-w-[400px]">
          <DialogHeader>
            <DialogTitle>{pendingDelete?.type === 'project' ? '移除项目' : '删除会话'}</DialogTitle>
            <DialogDescription className="whitespace-pre-line">
              {pendingDelete?.type === 'project'
                ? `确定移除「${pendingDelete.project.name}」？\n将从列表移除（不删磁盘文件），且不可恢复。`
                : '确定删除此会话？此操作不可恢复。'}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              disabled={deleting}
              onClick={() => setPendingDelete(null)}
            >
              取消
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={deleting}
              onClick={handleConfirmDelete}
            >
              {deleting ? '删除中…' : '删除'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function Chevron({ open }: { open: boolean }): React.JSX.Element {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      className={['shrink-0 transition-transform duration-150', open ? 'rotate-90' : ''].join(' ')}
    >
      <polyline points="6 4 10 8 6 12" />
    </svg>
  )
}

interface ProjectGroupProps {
  project: Project
  expanded: boolean
  /** 外部刷新 + 手动刷新合流信号，变化时重拉会话列表 */
  refreshTick: number
  currentSessionId: string | null
  onToggle: () => void
  onNewSession: (project: Project) => void
  onResumeSession: (session: SessionSummary, projectPath: string) => void
  onCloseSession: () => void
  onDeleteSession: (pending: {
    type: 'session'
    session: SessionSummary
    projectPath: string
  }) => void
  onRenameSession: (sid: string, projectPath: string, title: string) => void
  onRemoveProject: (pending: { type: 'project'; project: Project }) => void
}

/** 每个项目独立加载自己的会话（多项目展开互不串选） */
function ProjectGroup(props: ProjectGroupProps): React.JSX.Element {
  const {
    project,
    expanded,
    refreshTick,
    currentSessionId,
    onToggle,
    onNewSession,
    onResumeSession,
    onCloseSession,
    onDeleteSession,
    onRenameSession,
    onRemoveProject
  } = props
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    try {
      setSessions(await agentApi.listSessions(project.id))
    } catch {
      setSessions([])
    }
  }, [project.id])

  // 展开时加载；refreshTick 变化时（回复完毕/删除后）若展开则重拉
  useEffect(() => {
    if (expanded) void load()
  }, [expanded, load, refreshTick])

  // 存活会话恒置顶：同项目切换时旧会话被 evict 后 CLI 退出才 flush JSONL，
  // 其 lastModified 会晚于新激活会话（竞态偶发），纯时间排序会把旧会话顶到首位
  const sorted = useMemo(
    () =>
      [...(sessions ?? [])].sort(
        (a, b) => Number(b.live) - Number(a.live) || b.lastModified - a.lastModified
      ),
    [sessions]
  )

  return (
    <div>
      <div
        onClick={onToggle}
        className={[
          'group relative w-full flex items-center gap-1.5 px-3 py-2.5 cursor-pointer transition-colors duration-100',
          'hover:bg-[var(--overlay-hover)]',
          expanded ? 'bg-[var(--overlay-pressed)]' : ''
        ].join(' ')}
      >
        <Chevron open={expanded} />
        <Folder className="shrink-0 size-3.5 text-[var(--text-faint)]" />
        <span
          className="text-[13px] font-semibold text-[var(--text-base)] truncate flex-1 tracking-wide"
          title={project.path}
        >
          {project.name}
        </span>
        {sessions !== null && (
          <span className="text-[10px] text-[var(--text-faint)] shrink-0 bg-[var(--bg-layer-02)] px-1.5 py-0.5 rounded-md tabular-nums">
            {sessions.length}
          </span>
        )}
        <button
          onClick={(e) => {
            e.stopPropagation()
            setMenuOpen((v) => !v)
          }}
          className="size-6 flex items-center justify-center rounded-md transition-all text-[var(--text-muted)] hover:text-[var(--text-base)] hover:bg-[var(--overlay-pressed)] opacity-100 md:opacity-0 md:group-hover:opacity-100"
          title="操作"
        >
          <MoreVertical className="size-4" />
        </button>
        {menuOpen && (
          <>
            <div
              className="fixed inset-0 z-20"
              onClick={(e) => {
                e.stopPropagation() // 同上：防止点空白关菜单时顺带 toggle 项目行
                setMenuOpen(false)
              }}
            />
            <div className="absolute right-2 top-9 z-30 w-40 py-1 rounded-lg border border-[var(--border-muted)] bg-[var(--bg-base)] shadow-[var(--elevation-raised)]">
              <button
                onClick={(e) => {
                  // 阻断冒泡：菜单在项目行（onClick=onToggle）内，不阻断会先展开又被 toggle 折叠
                  e.stopPropagation()
                  setMenuOpen(false)
                  onNewSession(project)
                }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[13px] text-[var(--text-base)] hover:bg-[var(--overlay-hover)]"
              >
                <Plus className="size-3.5 shrink-0" />
                创建会话
              </button>
              <div className="my-1 border-t border-[var(--border-muted)]" />
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  setMenuOpen(false)
                  onRemoveProject({ type: 'project', project })
                }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[13px] text-red-500 hover:bg-[var(--overlay-hover)]"
              >
                <Trash2 className="size-3.5 shrink-0" />
                移除项目
              </button>
            </div>
          </>
        )}
      </div>

      {expanded && (
        <div className="ml-1 space-y-0.5 pt-1 pb-1">
          {sessions === null && (
            <div className="px-3 py-4 text-center text-[12px] text-[var(--text-faint)]">
              加载中…
            </div>
          )}
          {sessions !== null && sorted.length === 0 && (
            <div className="px-3 py-4 text-center text-[12px] text-[var(--text-faint)]">
              暂无会话
            </div>
          )}
          {sorted.map((s) => (
            <SessionItem
              key={s.id}
              session={s}
              isActive={s.id === currentSessionId}
              onClick={() => onResumeSession(s, project.path)}
              onClose={s.id === currentSessionId ? onCloseSession : undefined}
              onDelete={() =>
                onDeleteSession({ type: 'session', session: s, projectPath: project.path })
              }
              onRename={(title) => onRenameSession(s.id, project.path, title)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function SessionItem({
  session,
  isActive,
  onClick,
  onClose,
  onDelete,
  onRename
}: {
  session: SessionSummary
  isActive: boolean
  onClick: () => void
  /** 彻底关闭当前会话；仅当前活跃会话条目传入（历史会话无进程可关） */
  onClose?: () => void
  onDelete: () => void
  onRename: (title: string) => void
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(session.title || '')

  if (editing) {
    return (
      <div className="flex items-center gap-1 w-full pl-5 pr-2 py-1">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && draft.trim()) {
              onRename(draft.trim())
              setEditing(false)
            } else if (e.key === 'Escape') {
              setDraft(session.title || '')
              setEditing(false)
            }
          }}
          autoFocus
          className="min-w-0 flex-1 rounded-md border border-[var(--grey-400)] bg-[var(--bg-layer-01)] px-1.5 py-0.5 text-[12px] text-[var(--text-base)] outline-none"
        />
        <button
          onClick={() => {
            if (draft.trim()) {
              onRename(draft.trim())
              setEditing(false)
            }
          }}
          className="size-6 flex items-center justify-center rounded text-[var(--text-muted)] hover:text-[var(--text-base)] hover:bg-[var(--overlay-hover)]"
          title="确认"
        >
          <Check className="size-3" />
        </button>
        <button
          onClick={() => {
            setDraft(session.title || '')
            setEditing(false)
          }}
          className="size-6 flex items-center justify-center rounded text-[var(--text-muted)] hover:text-[var(--text-base)] hover:bg-[var(--overlay-hover)]"
          title="取消"
        >
          <X className="size-3" />
        </button>
      </div>
    )
  }

  const title = session.title || session.summary || session.id.slice(0, 8)
  return (
    <div
      onClick={onClick}
      className={[
        'group relative w-full text-left pl-5 pr-2 py-2 rounded-md transition-colors duration-100 cursor-pointer',
        isActive ? 'bg-[var(--bg-layer-01)]' : 'hover:bg-[var(--overlay-hover)]'
      ].join(' ')}
    >
      {isActive && (
        <span className="absolute left-0 top-1/2 -translate-y-1/2 h-4 w-[2.5px] rounded-r-full bg-primary" />
      )}
      <div className="flex items-start gap-2 pr-12">
        <MessageSquare className="size-3.5 shrink-0 mt-[2px] text-[var(--text-faint)]" />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] leading-snug text-[var(--text-base)] line-clamp-2 break-all">
            {title}
            {session.personaName && (
              <span
                className="ml-1 inline-block max-w-[90px] shrink-0 truncate rounded bg-[var(--bg-layer-02)] px-1 align-middle text-[10px] leading-4 text-[var(--text-muted)]"
                title={`智能体：${session.personaName}`}
              >
                {session.personaName}
              </span>
            )}
            {session.live && (
              <span
                className="ml-1 inline-block size-1.5 shrink-0 rounded-full bg-emerald-500 align-middle animate-pulse"
                title="会话存活（进程运行中）"
              />
            )}
          </div>
          <div className="flex items-center gap-2 mt-1">
            <span className="text-[10px] text-[var(--text-faint)]">
              {fmtTime(session.lastModified)}
            </span>
            {session.gitBranch && (
              <span className="text-[10px] text-[var(--text-faint)] truncate max-w-[100px]">
                {session.gitBranch}
              </span>
            )}
          </div>
        </div>
      </div>
      <div className="absolute right-1.5 top-1.5 flex gap-0.5 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity">
        {onClose && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              onClose()
            }}
            className="size-6 flex items-center justify-center rounded-md text-[var(--text-faint)] hover:text-[var(--text-base)] hover:bg-[var(--overlay-pressed)] transition-colors"
            title="关闭会话（终止进程并清理，历史保留）"
          >
            <X className="size-3.5" />
          </button>
        )}
        <button
          onClick={(e) => {
            e.stopPropagation()
            setEditing(true)
          }}
          className="size-6 flex items-center justify-center rounded-md text-[var(--text-faint)] hover:text-[var(--text-base)] hover:bg-[var(--overlay-pressed)] transition-colors"
          title="重命名"
        >
          <Pencil className="size-3" />
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation()
            onDelete()
          }}
          className="size-6 flex items-center justify-center rounded-md text-[var(--text-faint)] hover:text-red-500 hover:bg-[var(--overlay-pressed)] transition-colors"
          title="删除会话"
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>
    </div>
  )
}

function AddProjectDialog({
  open,
  onOpenChange,
  onAdd
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  onAdd: (name: string, path: string) => Promise<void>
}): React.JSX.Element {
  const [name, setName] = useState('')
  const [path, setPath] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (): Promise<void> => {
    if (!name.trim() || !path.trim()) return
    setBusy(true)
    try {
      await onAdd(name.trim(), path.trim())
      setName('')
      setPath('')
      onOpenChange(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>添加项目</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3 py-2">
          <label className="flex flex-col gap-1 text-[13px]">
            <span className="text-[var(--text-muted)]">名称</span>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-project"
            />
          </label>
          <label className="flex flex-col gap-1 text-[13px]">
            <span className="text-[var(--text-muted)]">路径（须存在于服务器磁盘）</span>
            <Input
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="/home/user/projects/demo"
            />
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>
            取消
          </Button>
          <Button
            size="sm"
            onClick={() => void submit()}
            disabled={!name.trim() || !path.trim() || busy}
          >
            {busy ? '添加中…' : '添加'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
