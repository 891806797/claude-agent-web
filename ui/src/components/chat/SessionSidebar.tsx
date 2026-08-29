import { Check, FileText, Pencil, Plus, RefreshCw, Trash2, X } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import type { Project, SessionSummary } from '@/lib/agent-types'

/**
 * 会话侧栏 —— 头部（添加项目 / 刷新）+ 项目列表 + 选中项目的历史会话。
 * 桌面端内嵌可拖拽宽度；手机端作为抽屉覆盖层（由 ChatPage 控制 open）。
 * 会话项：激活态左侧主色竖条（对齐 desktop），悬停显示重命名/删除。
 */
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

export function SessionSidebar({
  projects,
  selectedProjectId,
  sessions,
  currentSessionId,
  onSelectProject,
  onNewSession,
  onResumeSession,
  onDeleteSession,
  onRenameSession,
  onAddProject,
  onRefresh
}: {
  projects: Project[]
  selectedProjectId: string | null
  sessions: SessionSummary[]
  currentSessionId: string | null
  onSelectProject: (id: string) => void
  onNewSession: (project: Project) => void
  onResumeSession: (sid: string) => void
  onDeleteSession: (sid: string) => void
  onRenameSession: (sid: string, title: string) => void
  onAddProject: (name: string, path: string) => Promise<void>
  onRefresh: () => void
}): React.JSX.Element {
  const [addOpen, setAddOpen] = useState(false)

  return (
    <div className="flex h-full flex-col bg-card">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          项目与会话
        </span>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => setAddOpen(true)}
            className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label="添加项目"
          >
            <Plus className="size-4" />
          </button>
          <button
            type="button"
            onClick={onRefresh}
            className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label="刷新"
          >
            <RefreshCw className="size-3.5" />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {projects.length === 0 && (
          <p className="px-3 py-2 text-xs text-muted-foreground">点右上角 + 添加项目</p>
        )}
        {projects.map((p) => {
          const active = p.id === selectedProjectId
          return (
            <div key={p.id}>
              <button
                type="button"
                onClick={() => onSelectProject(p.id)}
                className={cn(
                  'flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left hover:bg-accent',
                  active && 'bg-accent'
                )}
              >
                <span className="truncate text-sm font-medium text-foreground">{p.name}</span>
                <span className="truncate text-xs text-muted-foreground">{p.path}</span>
              </button>

              {active && (
                <div className="flex flex-col border-l-2 border-primary/40 pl-1">
                  <button
                    type="button"
                    onClick={() => onNewSession(p)}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-primary hover:bg-accent"
                  >
                    <Plus className="size-3" />
                    新会话
                  </button>
                  {sessions.map((s) => (
                    <SessionRow
                      key={s.id}
                      session={s}
                      current={s.id === currentSessionId}
                      onResume={() => onResumeSession(s.id)}
                      onDelete={() => onDeleteSession(s.id)}
                      onRename={(title) => onRenameSession(s.id, title)}
                    />
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>

      <AddProjectDialog open={addOpen} onOpenChange={setAddOpen} onAdd={onAddProject} />
    </div>
  )
}

function SessionRow({
  session,
  current,
  onResume,
  onDelete,
  onRename
}: {
  session: SessionSummary
  current: boolean
  onResume: () => void
  onDelete: () => void
  onRename: (title: string) => void
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(session.title)
  const [confirming, setConfirming] = useState(false)

  if (editing) {
    return (
      <div className="flex items-center gap-1 px-2 py-1">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && draft.trim()) {
              onRename(draft.trim())
              setEditing(false)
            } else if (e.key === 'Escape') {
              setDraft(session.title)
              setEditing(false)
            }
          }}
          autoFocus
          className="min-w-0 flex-1 rounded border border-border bg-background px-1.5 py-0.5 text-xs"
        />
        <button
          type="button"
          onClick={() => {
            if (draft.trim()) {
              onRename(draft.trim())
              setEditing(false)
            }
          }}
          className="text-muted-foreground hover:text-foreground"
        >
          <Check className="size-3" />
        </button>
        <button
          type="button"
          onClick={() => {
            setDraft(session.title)
            setEditing(false)
          }}
          className="text-muted-foreground hover:text-foreground"
        >
          <X className="size-3" />
        </button>
      </div>
    )
  }

  if (confirming) {
    return (
      <div className="flex items-center gap-1 px-2 py-1 text-xs">
        <span className="text-destructive">删除？</span>
        <button
          type="button"
          onClick={onDelete}
          className="font-medium text-destructive hover:underline"
        >
          是
        </button>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          className="text-muted-foreground hover:underline"
        >
          否
        </button>
      </div>
    )
  }

  return (
    <div className="group relative w-full pl-5 pr-2 py-1.5 text-xs hover:bg-accent">
      {current && (
        <span className="absolute left-0 top-1/2 h-4 w-[2.5px] -translate-y-1/2 rounded-r-full bg-primary" />
      )}
      <button
        type="button"
        onClick={onResume}
        className="flex min-w-0 flex-1 flex-col items-start gap-0.5"
      >
        <span className="flex w-full items-center gap-1.5">
          <FileText className="size-3 shrink-0 text-muted-foreground" />
          <span className="truncate text-foreground">{session.title}</span>
        </span>
        <span className="pl-4 text-muted-foreground">{fmtTime(session.lastModified)}</span>
      </button>
      <div className="absolute right-1 top-1.5 flex opacity-0 group-hover:opacity-100">
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="text-muted-foreground hover:text-foreground"
          aria-label="重命名"
        >
          <Pencil className="size-3" />
        </button>
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="text-muted-foreground hover:text-destructive"
          aria-label="删除"
        >
          <Trash2 className="size-3" />
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
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">名称</span>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-project"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">路径（须存在于磁盘）</span>
            <Input
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="D:/worker/projects/demo"
            />
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={submit} disabled={!name.trim() || !path.trim() || busy}>
            添加
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
