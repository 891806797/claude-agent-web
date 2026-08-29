import { useCallback, useEffect, useMemo, useState } from 'react'
import { useChatAgent } from '@/hooks/useChatAgent'
import { useChatStore } from '@/stores/chat'
import { agentApi, ApiError } from '@/lib/agent-api'
import type {
  AgentStatus,
  ApprovalRequest,
  Attachment,
  ChatMessage,
  ContextUsage,
  Persona,
  SessionCloseReason,
  SlashCommand,
  Usage
} from '@/lib/agent-types'

/**
 * desktop ChatAgentApi 同形适配层 —— 照搬组件（ChatMessageList/PromptInput/CostCircle…）
 * 消费的唯一数据源接口。web 逻辑层（useChatAgent + useChatStore）经此包装后，
 * ported 组件除类型导入路径外零改动。
 *
 * 关键映射：
 * - sessionId 取 hook 的 sid（切会话即时可用；store.sessionId 仅事件回填）
 * - isRunning = status 运行态 ∨ 压缩中；isSwitchingSession = hook.busy（resume/openNew 全程）
 * - approve 四参（desktop 签名）→ web 单对象参
 * - sendMessage 的 file 附件丢弃（@path 已随文本写入，后端按文本处理）
 */

/** 回滚结果（web rewind 无 dryRun 预览，失败返回 null） */
export interface RewindResult {
  success: boolean
  message?: string
}

export interface ChatAgentApi {
  messages: ChatMessage[]
  /** 当前项目 id（ChatInput 文件搜索数据源；null = 未选项目） */
  projectId: string | null
  status: AgentStatus | 'idle'
  isRunning: boolean
  /** SDK 上下文压缩进行中（压缩期间输入锁定，StatusBar 显示压缩态） */
  isCompacting: boolean
  /** 切换会话中：resumeSession/openNew await 期间 true，消息列表显示 loading；
   *  含 evict 自动恢复窗口（多 tab 切换时本 tab 被动等待新进程就绪，同样锁发送） */
  isSwitchingSession: boolean
  activeToolCall: { id: string; name: string; interruptible: boolean } | null
  lastError: string | null
  sessionId: string | null
  /** 会话工作区绝对路径（URL 恢复 / 404 会话恢复定位项目用） */
  ws: string | null
  /** 会话终结原因（query_closed）；null = 进行中 */
  closed: { reason: SessionCloseReason } | null
  /** 最近一次 checkpoint UUID（用于文件回滚）；null 表示无 checkpoint */
  lastCheckpointId: string | null
  approvalRequests: ApprovalRequest[]
  commands: SlashCommand[]
  /** 当前选定的智能体（活会话 = 已生效人格；无会话 = 下次新会话生效） */
  personaId: string | undefined
  /** persona 显示名（列表名 → 绑定快照名兜底；'标准' = 标准 Claude） */
  personaLabel: string
  personas: Persona[]
  personasLoading: boolean
  /** persona 选择统一入口：活会话且空闲 → 热切换（替换进程，历史保留）；否则纯选择。
   *  切换失败上抛（调用方 toast）；成功后以服务端绑定快照回读校准 */
  selectPersona: (id: string | undefined) => Promise<void>
  /** persona 列表刷新（popover 打开时调用，保持选择器永远新鲜） */
  loadPersonas: () => void
  /** 本 turn 累计用量（CostCircle 环形图数据源） */
  usage: Usage | null
  /** 最近一次 context_usage 快照（CostCircle 下拉明细） */
  contextUsage: ContextUsage | null
  sendMessage: (text: string, attachments?: Attachment[]) => void
  /** 中断当前进行中的 turn（保活会话） */
  interruptRun: () => void
  /** 关闭会话（断 SSE + 清状态） */
  closeRun: () => void
  /** resume 指定会话；projectId 显式传入（选中态 setState 尚未生效时避免闭包旧值） */
  resumeSession: (sessionId: string, projectId?: string, evict?: boolean) => Promise<void>
  /** 开新会话；evict=true 接管他人占用的会话位。
   *  返回 null = 请求期间被更新的会话操作取代（结果已丢弃，调用方不应再写 URL） */
  openNewSession: (
    projectId: string,
    evict?: boolean
  ) => Promise<{ workspaceDir: string; sessionId: string } | null>
  /** URL 恢复第一步：命中本人活跃会话则直连 SSE，返回 false 供调用方走 resume */
  attachExisting: (workspaceDir: string, sid: string) => Promise<boolean>
  approve: (
    toolCallId: string,
    allowed: boolean,
    modifiedInput?: Record<string, unknown>,
    feedback?: string,
    alwaysAllow?: boolean
  ) => Promise<void>
  /** 回滚文件到指定 checkpoint；web 无 dryRun 预览，失败返回 null */
  rewindFiles: (checkpointId: string, dryRun?: boolean) => Promise<RewindResult | null>
  clearSession: () => void
}

export function useChatAgentApi(opts: { projectId: string | null }): ChatAgentApi {
  const { projectId } = opts
  const agent = useChatAgent()

  const isCompacting = useChatStore((s) => s.isCompacting)
  const contextUsage = useChatStore((s) => s.contextUsage)
  const activeTool = useChatStore((s) => s.activeToolCall)
  const lastError = useChatStore((s) => s.lastError)
  const usage = useChatStore((s) => s.usage)
  const reset = useChatStore((s) => s.reset)

  const [commands, setCommands] = useState<SlashCommand[]>([])

  const [personaId, setPersonaId] = useState<string | undefined>(undefined)
  /** 回读兜底名：persona 已删除但会话仍绑定快照时，显示名取服务端快照名 */
  const [personaFallbackName, setPersonaFallbackName] = useState<string | undefined>(undefined)
  const [personas, setPersonas] = useState<Persona[]>([])
  const [personasLoading, setPersonasLoading] = useState(false)

  // persona 列表：挂载拉一次（按钮显示名需要），popover 打开时再刷新（低频小列表永远新鲜）
  const loadPersonas = useCallback((): void => {
    setPersonasLoading(true)
    agentApi
      .listPersonas()
      .then(setPersonas)
      .catch(() => {})
      .finally(() => setPersonasLoading(false))
  }, [])
  useEffect(() => {
    loadPersonas()
  }, [loadPersonas])

  /** 以服务端绑定快照校准本地选择（attach/resume/openNew 后由 ws/sid effect 收口；
   *  切换后手动调用——同 sid 不触发 effect）。失败静默保留现值，注入不受影响 */
  const syncPersonaFromServer = useCallback(async (workspaceDir: string): Promise<void> => {
    try {
      const res = await agentApi.getActiveSession(workspaceDir)
      if (res.active) {
        setPersonaId(res.active.personaId)
        setPersonaFallbackName(res.active.personaName)
      }
    } catch {
      /* 校准失败保留现值（仅显示滞后，注入以服务端为准） */
    }
  }, [])

  // 会话建立/切换（ws/sid 变化）即回读校准：显示与该会话注入永远一致；
  // 同 sid 进程替换（evict 自动恢复）不触发 ws/sid 变化，以 recoveryNonce 补触发
  const agentWs = agent.ws
  const agentSid = agent.sid
  const recoveryNonce = agent.recoveryNonce
  useEffect(() => {
    if (agentWs && agentSid) void syncPersonaFromServer(agentWs)
  }, [agentWs, agentSid, recoveryNonce, syncPersonaFromServer])

  // 斜杠命令：项目确定后加载一次（局部缓存语义，切换项目会重拉）
  useEffect(() => {
    if (!projectId) return
    let cancelled = false
    agentApi
      .getCommands(projectId)
      .then((cs) => {
        if (!cancelled) setCommands(cs)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [projectId])

  const sendMessage = useCallback(
    (text: string, attachments?: Attachment[]) => {
      const images = attachments
        ?.filter((a): a is Extract<Attachment, { type: 'image' }> => a.type === 'image')
        .map((a) => ({ dataUrl: a.dataUrl, mime: a.mime }))
      void agent
        .send(text, images?.length ? images : undefined)
        .catch(async (err: unknown) => {
          // 404 = 会话被服务端回收（空闲 GC / 重启）：按 ws 定位项目 resume 后重发原消息
          if (err instanceof ApiError && err.status === 404 && agent.ws && agent.sid) {
            try {
              const matched = await agentApi
                .listProjects()
                .then((ps) => ps.find((p) => p.path === agent.ws))
              if (!matched) throw err
              await agent.resume(matched.id, agent.sid)
              await agent.send(text, images?.length ? images : undefined)
            } catch {
              /* 恢复失败由 store error 事件提示 */
            }
            return
          }
          throw err
        })
        .catch(() => {})
    },
    [agent]
  )

  const approve = useCallback(
    async (
      toolCallId: string,
      allowed: boolean,
      modifiedInput?: Record<string, unknown>,
      feedback?: string,
      alwaysAllow?: boolean
    ) => {
      await agent.approve(toolCallId, {
        allowed,
        ...(modifiedInput ? { updatedInput: modifiedInput } : {}),
        ...(feedback ? { feedback } : {}),
        ...(alwaysAllow ? { alwaysAllow } : {})
      })
    },
    [agent]
  )

  const rewindFiles = useCallback(
    async (checkpointId: string, dryRun?: boolean): Promise<RewindResult | null> => {
      if (dryRun) return null // web rewind 无预览（UserBubble 不做 dryRun 统计块）
      try {
        await agent.rewind(checkpointId)
        return { success: true }
      } catch {
        return null
      }
    },
    [agent]
  )

  const resumeSession = useCallback(
    async (sessionId: string, projectIdArg?: string, evict?: boolean) => {
      const pid = projectIdArg ?? projectId
      if (!pid) return
      await agent.resume(pid, sessionId, evict)
    },
    [agent, projectId]
  )

  const openNewSession = useCallback(
    async (projectId: string, evict?: boolean) => {
      return agent.openNew(projectId, undefined, evict, personaId)
    },
    [agent, personaId]
  )

  const isRunning =
    agent.status === 'thinking' ||
    agent.status === 'responding' ||
    agent.status === 'tool-use' ||
    isCompacting

  /** persona 选择统一入口：活会话且空闲 → 热切换（服务端替换进程并同 sid resume，历史保留）；
   *  否则纯选择（下次新会话生效）。切换失败上抛（组件层 toast），成功以回读校准 */
  const selectPersona = useCallback(
    async (id: string | undefined): Promise<void> => {
      if (agent.sid && !isRunning && !agent.busy) {
        await agent.switchPersona(id ?? null)
        // 同 sid 切换不触发 ws/sid effect，手动回读（服务端绑定快照为准）
        if (agent.ws) await syncPersonaFromServer(agent.ws)
        return
      }
      setPersonaId(id)
      setPersonaFallbackName(undefined)
    },
    [agent, isRunning, syncPersonaFromServer]
  )

  const personaLabel = personaId
    ? (personas.find((p) => p.id === personaId)?.name ?? personaFallbackName ?? '智能体')
    : '标准'

  const attachExisting = useCallback(
    async (workspaceDir: string, sid: string) => agent.attachActive(workspaceDir, sid),
    [agent]
  )

  return useMemo(
    () => ({
      messages: agent.messages,
      projectId,
      status: agent.status,
      isRunning,
      isCompacting,
      isSwitchingSession: agent.busy || agent.recovering,
      // web 的 interrupt 为会话级：任何工具运行中均可中断
      activeToolCall: activeTool ? { ...activeTool, interruptible: true } : null,
      lastError,
      sessionId: agent.sid,
      ws: agent.ws,
      closed: agent.closed,
      lastCheckpointId: agent.lastCheckpoint,
      approvalRequests: agent.approvals,
      commands,
      personaId,
      personaLabel,
      personas,
      personasLoading,
      selectPersona,
      loadPersonas,
      usage,
      contextUsage,
      sendMessage,
      interruptRun: () => void agent.interrupt(),
      closeRun: () => void agent.closeSession(),
      resumeSession,
      openNewSession,
      attachExisting,
      approve,
      rewindFiles,
      clearSession: reset
    }),
    [
      agent,
      projectId,
      isRunning,
      isCompacting,
      activeTool,
      lastError,
      commands,
      personaId,
      personaLabel,
      personas,
      personasLoading,
      selectPersona,
      loadPersonas,
      usage,
      contextUsage,
      sendMessage,
      resumeSession,
      openNewSession,
      attachExisting,
      approve,
      rewindFiles,
      reset
    ]
  )
}
