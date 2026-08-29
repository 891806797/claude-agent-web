import { useEffect, useState } from 'react'
import { type SetURLSearchParams, useSearchParams } from 'react-router-dom'
import { Bot, LayoutDashboard, PanelLeft, PanelRight, Settings, Undo2 } from 'lucide-react'
import { AskUserQuestionApproval } from '@/components/chat/AskUserQuestionApproval'
import { ApprovalCard, type ApprovalResolution } from '@/components/chat/ApprovalCard'
import { ChatMessageList } from '@/components/chat/ChatMessageList'
import { FileTree } from '@/components/chat/FileTree'
import { PromptInput } from '@/components/chat/PromptInput'
import { SessionSidebar } from '@/components/chat/SessionSidebar'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/sonner'
import { useChatAgent } from '@/hooks/useChatAgent'
import { useIsMobile } from '@/hooks/useIsMobile'
import { useChatStore } from '@/stores/chat'
import { agentApi, encodeDir, ApiError } from '@/lib/agent-api'
import type { Project, SessionSummary, SlashCommand } from '@/lib/agent-types'
import { cn } from '@/lib/utils'

const RUNNING_STATES = new Set(['turn-running', 'thinking', 'responding', 'tool-use'])

export function ChatPage(): React.JSX.Element {
  const agent = useChatAgent()
  const usage = useChatStore((s) => s.usage)
  const isMobile = useIsMobile()

  const [projects, setProjects] = useState<Project[]>([])
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [commands, setCommands] = useState<SlashCommand[]>([])
  const [params, setParams] = useSearchParams()
  const [hydrated, setHydrated] = useState(false)

  // 抽屉 + 输入态
  const [leftOpen, setLeftOpen] = useState(false)
  const [rightOpen, setRightOpen] = useState(false)
  const [inputText, setInputText] = useState('')

  useEffect(() => {
    agentApi
      .listProjects()
      .then(setProjects)
      .catch(() => toast.error('加载项目列表失败'))
  }, [])

  const loadSessions = (projectId: string): void => {
    agentApi
      .listSessions(projectId)
      .then(setSessions)
      .catch(() => setSessions([]))
  }
  const loadCommands = (projectId: string): void => {
    agentApi
      .getCommands(projectId)
      .then(setCommands)
      .catch(() => setCommands([]))
  }
  const onSelectProject = (id: string): void => {
    setSelectedProjectId(id)
    loadSessions(id)
  }

  // 统一接入：URL 有 ws+sid 时 attach / resume
  useEffect(() => {
    if (hydrated || projects.length === 0) return
    const wsParam = params.get('ws')
    const sidParam = params.get('sid')
    if (!wsParam || !sidParam) {
      setHydrated(true)
      return
    }
    const matched = projects.find((p) => encodeDir(p.path) === wsParam)
    setHydrated(true)
    if (!matched) {
      toast.error('项目未注册或已被移除')
      return
    }
    setSelectedProjectId(matched.id)
    loadSessions(matched.id)
    loadCommands(matched.id)
    void (async () => {
      try {
        const attached = await agent.attachActive(matched.path, sidParam)
        if (!attached) await agent.resume(matched.id, sidParam)
        syncUrl(params, setParams, matched.path, agent.sid ?? sidParam)
      } catch (err) {
        toast.error(err instanceof ApiError ? err.message : '恢复会话失败')
      }
    })()
    // biome-ignore lint/correctness/useExhaustiveDependencies: 依赖刻意收敛
  }, [projects, params, agent])

  const running = RUNNING_STATES.has(agent.status)
  const bound = agent.ws !== null && agent.sid !== null

  const handleSend = async (text: string, images?: Array<{ dataUrl: string; mime: string }>) => {
    if (!bound) return
    try {
      await agent.send(text, images)
    } catch (err) {
      if (err instanceof ApiError && err.status === 404 && agent.ws && agent.sid) {
        const matched = projects.find((p) => encodeDir(p.path) === encodeDir(agent.ws!))
        if (!matched) {
          toast.error('会话已失效且找不到对应项目')
          return
        }
        try {
          await agent.resume(matched.id, agent.sid)
          await agent.send(text, images)
        } catch (e2) {
          toast.error(e2 instanceof ApiError ? e2.message : '恢复后重发失败')
        }
        return
      }
      toast.error(err instanceof ApiError ? err.message : '发送失败')
    }
  }

  const handleApprove = async (toolCallId: string, res: ApprovalResolution) => {
    try {
      await agent.approve(toolCallId, res)
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : '审批提交失败')
    }
  }

  const openNew = async (project: Project) => {
    try {
      const outcome = await agent.openNew(project.id)
      setSelectedProjectId(project.id)
      loadSessions(project.id)
      loadCommands(project.id)
      syncUrl(params, setParams, outcome.workspaceDir, outcome.sessionId)
      setLeftOpen(false)
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : '开会话失败')
    }
  }

  const resumeSession = async (sid: string) => {
    if (!selectedProjectId) return
    const project = projects.find((p) => p.id === selectedProjectId)
    if (!project) return
    try {
      await agent.resume(project.id, sid)
      loadCommands(project.id)
      syncUrl(params, setParams, project.path, sid)
      setLeftOpen(false)
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : '恢复会话失败')
    }
  }

  const deleteSession = async (sid: string) => {
    if (!selectedProjectId) return
    const project = projects.find((p) => p.id === selectedProjectId)
    if (!project) return
    try {
      await agentApi.deleteSession(sid, project.path)
      if (agent.sid === sid) agent.closeSession()
      loadSessions(project.id)
      toast.success('会话已删除')
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : '删除会话失败')
    }
  }

  const renameSession = async (sid: string, title: string) => {
    if (!selectedProjectId) return
    const project = projects.find((p) => p.id === selectedProjectId)
    if (!project) return
    try {
      await agentApi.renameSession(sid, project.path, title)
      loadSessions(project.id)
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : '重命名失败')
    }
  }

  const addProject = async (name: string, path: string) => {
    try {
      await agentApi.createProject(name, path)
      setProjects(await agentApi.listProjects())
      toast.success('项目已添加')
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : '添加失败')
    }
  }

  const refreshAll = () => {
    agentApi
      .listProjects()
      .then(setProjects)
      .catch(() => {})
    if (selectedProjectId) loadSessions(selectedProjectId)
  }

  const insertPath = (path: string) => {
    setInputText((prev) => `${prev}@${path} `)
  }

  const drawerWidth = isMobile ? 'w-[85vw] max-w-[320px]' : 'w-[300px]'

  return (
    <div className="relative flex h-screen overflow-hidden bg-background">
      {/* 左抽屉：项目与会话 */}
      <Drawer
        open={leftOpen}
        side="left"
        widthClass={drawerWidth}
        onClose={() => setLeftOpen(false)}
      >
        <SessionSidebar
          projects={projects}
          selectedProjectId={selectedProjectId}
          sessions={sessions}
          currentSessionId={agent.sid}
          onSelectProject={onSelectProject}
          onNewSession={openNew}
          onResumeSession={resumeSession}
          onDeleteSession={deleteSession}
          onRenameSession={renameSession}
          onAddProject={addProject}
          onRefresh={refreshAll}
        />
      </Drawer>

      {/* 右抽屉：文件树 */}
      <Drawer
        open={rightOpen}
        side="right"
        widthClass={drawerWidth}
        onClose={() => setRightOpen(false)}
      >
        <FileTree projectId={selectedProjectId} onInsertPath={insertPath} />
      </Drawer>

      {/* 中间聊天列 */}
      <div className="flex h-full min-w-0 flex-1 flex-col">
        <header className="flex h-11 shrink-0 items-center justify-between border-b border-border px-2">
          <button
            type="button"
            onClick={() => setLeftOpen((v) => !v)}
            className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label="项目与会话"
          >
            <PanelLeft className="size-4" />
          </button>

          <div className="flex items-center gap-2 text-sm">
            <Bot className="size-4 text-muted-foreground" />
            <span className="font-medium text-foreground">Claude</span>
            <span className="text-muted-foreground">· {agent.status}</span>
          </div>

          <div className="flex items-center gap-1">
            {usage && (
              <span className="text-xs text-muted-foreground">
                ↑{usage.inputTokens.toLocaleString()} ↓{usage.outputTokens.toLocaleString()}
              </span>
            )}
            {bound && agent.lastCheckpoint && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void agent.rewind(agent.lastCheckpoint!)}
              >
                <Undo2 className="size-3.5" />
                回滚
              </Button>
            )}
            <button
              type="button"
              onClick={() => setRightOpen((v) => !v)}
              className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label="文件树"
            >
              <PanelRight className="size-4" />
            </button>
            <a
              href="/dashboard"
              className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label="看板"
            >
              <LayoutDashboard className="size-4" />
            </a>
            <a
              href="/admin"
              className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label="管理"
            >
              <Settings className="size-4" />
            </a>
          </div>
        </header>

        {/* 聊天卡面（elevated） */}
        {bound ? (
          <div className="m-2 flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-card shadow-sm">
            <ChatMessageList messages={agent.messages} />

            {agent.approvals.length > 0 && (
              <div className="flex flex-col gap-2 border-t border-border bg-muted/30 p-3">
                {agent.approvals.map((a) =>
                  a.toolName === 'AskUserQuestion' ? (
                    <AskUserQuestionApproval
                      key={a.toolCallId}
                      approval={a}
                      onResolve={(res) => void handleApprove(a.toolCallId, res)}
                    />
                  ) : (
                    <ApprovalCard
                      key={a.toolCallId}
                      approval={a}
                      settled={agent.settled[a.toolCallId]}
                      onResolve={(res) => void handleApprove(a.toolCallId, res)}
                    />
                  )
                )}
              </div>
            )}

            {agent.closed && (
              <div className="border-t border-border bg-muted/40 px-4 py-2 text-center text-xs text-muted-foreground">
                会话已关闭（{reasonLabel(agent.closed.reason)}）— 刷新页面可从历史恢复
              </div>
            )}

            <PromptInput
              value={inputText}
              onChange={setInputText}
              onSend={handleSend}
              onInterrupt={() => void agent.interrupt()}
              running={running}
              closed={agent.closed !== null}
              commands={commands}
              projectId={selectedProjectId}
            />
          </div>
        ) : (
          <div className="m-2 flex flex-1 flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border text-muted-foreground">
            <PanelLeft className="size-8" />
            <p className="px-6 text-center text-sm">
              {hydrated ? '点击左上角按钮，添加项目或恢复历史会话' : '正在加载…'}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

/** 抽屉覆盖层：从左/右滑出，带 backdrop（点击关闭）。PC 与手机同款（宽度由 widthClass 定）。 */
function Drawer({
  open,
  side,
  widthClass,
  onClose,
  children
}: {
  open: boolean
  side: 'left' | 'right'
  widthClass: string
  onClose: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <>
      {open && <div className="fixed inset-0 z-30 bg-black/20" onClick={onClose} />}
      <div
        className={cn(
          'fixed inset-y-0 z-40 h-full shadow-lg transition-transform duration-200',
          side === 'left' ? 'left-0' : 'right-0',
          widthClass,
          open ? 'translate-x-0' : side === 'left' ? '-translate-x-full' : 'translate-x-full'
        )}
      >
        {children}
      </div>
    </>
  )
}

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

function reasonLabel(reason: string): string {
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
