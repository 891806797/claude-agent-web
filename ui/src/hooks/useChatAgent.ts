import { useCallback, useEffect, useRef, useState } from 'react'
import { useChatStore } from '@/stores/chat'
import { agentApi, type ApiError } from '@/lib/agent-api'
import { openAgentSSE, type AgentSSE } from '@/lib/sse-client'
import type { AgentStatus, PendingApproval } from '@/lib/agent-types'

/**
 * 聊天代理编排 hook —— SSE 生命周期 + 统一接入模型 + 会话操作。
 *
 * 统一接入模型：刷新/服务重启/GC 回归三种场景同一代码路径——
 *   attachActive(ws,sid) 命中本人活跃会话 → 直连 SSE（缓冲重放近期事件，不 loadHistory 防重复）；
 *   未命中 → resume(projectId,sid) openSession({resume}) → loadHistory(JSONL) + 连 SSE（新进程无缓冲重叠）。
 *
 * seq 幂等：EventSource 原生 Last-Event-ID 让服务端增量重放；本地 lastSeq 兜底过滤重连竞态导致的
 * 重复追加型事件（text_chunk 双写）。seq 跳跃（缓冲覆盖不到的空洞）→ 拉历史快照整段替换。
 * query_closed 到达即 sse.close() 防 EventSource 对已关闭会话 404 重连风暴。
 */
export function useChatAgent() {
  const messages = useChatStore((s) => s.messages)
  const approvals = useChatStore((s) => s.approvals)
  const settled = useChatStore((s) => s.settled)
  const status = useChatStore((s) => s.status)
  const closed = useChatStore((s) => s.closed)
  const sessionId = useChatStore((s) => s.sessionId)
  const lastCheckpoint = useChatStore((s) => s.lastCheckpoint)
  const reset = useChatStore((s) => s.reset)
  const applyEvent = useChatStore((s) => s.applyEvent)
  const pushLocalUser = useChatStore((s) => s.pushLocalUser)
  const loadHistory = useChatStore((s) => s.loadHistory)

  const sseRef = useRef<AgentSSE | null>(null)
  const lastSeq = useRef(0)
  const reconciling = useRef(false)
  const [ws, setWs] = useState<string | null>(null)
  const [sid, setSid] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const closeSse = useCallback(() => {
    sseRef.current?.close()
    sseRef.current = null
  }, [])

  const startSse = useCallback(
    (workspaceDir: string, sessionId: string) => {
      closeSse()
      lastSeq.current = 0
      const sse = openAgentSSE(agentApi.eventsUrl(sessionId, workspaceDir), {
        onEvent: (ev) => {
          // seq 跳跃（已流式过 + 缓冲覆盖不到）→ 历史快照对账，跳过本条防重复
          if (lastSeq.current > 0 && ev.seq > lastSeq.current + 1 && !reconciling.current) {
            reconciling.current = true
            void agentApi
              .getMessages(sessionId, workspaceDir)
              .catch(() => [])
              .then((history) => {
                loadHistory(history, sessionId)
                lastSeq.current = ev.seq
                applyEvent(ev)
                reconciling.current = false
              })
            return
          }
          if (ev.seq <= lastSeq.current) return
          lastSeq.current = ev.seq
          applyEvent(ev)
        },
        onApprovalReplay: (p: PendingApproval) => {
          const cur = useChatStore.getState().approvals
          if (!cur.some((a) => a.toolCallId === p.toolCallId)) {
            useChatStore.setState({ approvals: [...cur, p] })
          }
        },
        onClosed: () => {
          // 会话已终结：断开 SSE 防 404 重连风暴（closed 态由 query_closed 事件写入 store）
          closeSse()
        }
      })
      sseRef.current = sse
    },
    [applyEvent, loadHistory, closeSse]
  )

  // ===== 统一接入 =====

  /** 命中本人活跃会话则直连 SSE（缓冲重放，不 loadHistory）；否则返回 false 供调用方 resume */
  const attachActive = useCallback(
    async (workspaceDir: string, sid: string): Promise<boolean> => {
      const res = await agentApi.getActiveSession(workspaceDir)
      if (res.active && res.active.sessionId === sid) {
        setWs(workspaceDir)
        setSid(sid)
        startSse(workspaceDir, sid)
        return true
      }
      return false
    },
    [startSse]
  )

  /** resume 历史会话（空闲回收/服务重启后无感恢复） */
  const resume = useCallback(
    async (projectId: string, sid: string) => {
      const outcome = await agentApi.openSession({ projectId, resumeSessionId: sid })
      setWs(outcome.workspaceDir)
      setSid(outcome.sessionId)
      const history = await agentApi
        .getMessages(outcome.sessionId, outcome.workspaceDir)
        .catch(() => [])
      loadHistory(history, outcome.sessionId)
      startSse(outcome.workspaceDir, outcome.sessionId)
    },
    [loadHistory, startSse]
  )

  /** 开新会话（可选首条消息） */
  const openNew = useCallback(
    async (projectId: string, firstMessage?: string) => {
      reset()
      const outcome = await agentApi.openSession({ projectId, firstMessage })
      setWs(outcome.workspaceDir)
      setSid(outcome.sessionId)
      if (firstMessage) pushLocalUser(firstMessage)
      startSse(outcome.workspaceDir, outcome.sessionId)
      return outcome
    },
    [reset, pushLocalUser, startSse]
  )

  // ===== 会话操作 =====

  const send = useCallback(
    async (text: string, images?: Array<{ dataUrl: string; mime: string }>) => {
      if (!ws || !sid) return
      pushLocalUser(text)
      // 404（会话被回收）由 ChatPage 捕获后走 resume 流程恢复并重放原消息
      await agentApi.sendMessage(sid, ws, { text, ...(images?.length ? { images } : {}) })
    },
    [ws, sid, pushLocalUser]
  )

  const approve = useCallback(
    async (
      toolCallId: string,
      res: {
        allowed: boolean
        updatedInput?: Record<string, unknown>
        feedback?: string
        alwaysAllow?: boolean
      }
    ) => {
      if (!ws || !sid) return
      await agentApi.approve(sid, ws, { toolCallId, ...res })
    },
    [ws, sid]
  )

  const interrupt = useCallback(async () => {
    if (!ws || !sid) return
    await agentApi.interrupt(sid, ws).catch(() => {})
  }, [ws, sid])

  /** 回滚文件到 checkpoint（user message uuid），随后重载历史 */
  const rewind = useCallback(
    async (messageId: string) => {
      if (!ws || !sid) return
      await agentApi.rewind(sid, ws, messageId)
      const history = await agentApi.getMessages(sid, ws).catch(() => [])
      loadHistory(history, sid)
    },
    [ws, sid, loadHistory]
  )

  const closeSession = useCallback(async () => {
    if (!ws || !sid) return
    await agentApi.closeSession(sid, ws).catch(() => {})
    closeSse()
    reset()
    setWs(null)
    setSid(null)
  }, [ws, sid, closeSse, reset])

  // 卸载断开
  useEffect(() => closeSse, [closeSse])

  return {
    ws,
    sid,
    messages,
    approvals,
    settled,
    status: status as AgentStatus,
    closed,
    sessionId,
    lastCheckpoint,
    busy,
    setBusy,
    attachActive,
    resume,
    openNew,
    send,
    approve,
    interrupt,
    rewind,
    closeSession
  }
}

export type { ApiError }
