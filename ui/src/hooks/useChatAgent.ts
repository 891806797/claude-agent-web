import { useCallback, useEffect, useRef, useState } from 'react'
import { useChatStore } from '@/stores/chat'
import { agentApi, type ApiError } from '@/lib/agent-api'
import { openAgentSSE, type AgentSSE } from '@/lib/sse-client'
import type {
  AgentStatus,
  PendingApproval,
  RunMode,
  SequencedEvent,
  SessionCloseReason
} from '@/lib/agent-types'

/**
 * 聊天代理编排 hook —— SSE 生命周期 + 统一接入模型 + 会话操作。
 *
 * 统一接入模型：刷新/服务重启/GC 回归三种场景同一代码路径——
 *   attachActive(ws,sid) 命中本人活跃会话 → getMessages 全量 loadHistory + 以响应 seq 为锚
 *   SSE 增量重放（sinceSeq）：已落盘事件不重放（无重复）、锚点后事件必在缓冲（无缺口），
 *   不再依赖缓冲重放重建消息（ctx 被 resume 重建后缓冲近空 → 空白；长会话缓冲滚动 → 头部截断）；
 *   未命中 → resume(projectId,sid) openSession({resume}) → loadHistory(JSONL) + 连 SSE（新进程无缓冲重叠）。
 *
 * seq 幂等：EventSource 原生 Last-Event-ID 让服务端增量重放；本地 lastSeq 兜底过滤重连竞态导致的
 * 重复追加型事件（text_chunk 双写）。seq 跳跃（缓冲覆盖不到的空洞）→ 拉历史快照整段替换。
 * query_closed 到达即 sse.close() 防 EventSource 对已关闭会话 404 重连风暴；
 * reason=evict（多 tab 智能体切换等进程替换）例外——先退避探测无感恢复，失败才落 closed 横幅。
 */

/** evict 自动恢复的探测退避间隔（旧 ctx 广播 query_closed 时新进程尚在启动，总窗口约 5s） */
const EVICT_RECOVERY_DELAYS = [500, 1500, 3000] as const

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
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
  // 破 startSse ↔ recoverFromEvict 循环依赖：恢复流程经 ref 取最新 startSse 重连
  const startSseRef = useRef<(workspaceDir: string, sessionId: string) => void>(() => {})
  const lastSeq = useRef(0)
  const reconciling = useRef(false)
  // 会话代际：每次 openNew/resume/attach 递增。异步回调（loadHistory/对账）携带发起时
  // 的代际，返回时发现已被更新操作取代即丢弃 -- 防止慢请求把老会话消息写入新会话视图
  // （如 resume 进行中点"创建会话"，迟到的 loadHistory 整段覆盖新会话）。
  const genRef = useRef(0)
  /** 锚定 attach 后待一次历史自愈刷新：attach 时刻正流式的消息不在 JSONL、事件 seq ≤ 锚点被
   *  过滤 → 本轮缺失；turn_end 后 JSONL 已补全，刷新一次闭环（不动 lastSeq，后续事件正常）。 */
  const pendingHistoryRefresh = useRef(false)
  const [ws, setWs] = useState<string | null>(null)
  const [sid, setSid] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /** evict 自动恢复进行中（多 tab 切换：本 tab 被动等待新进程就绪）；独立于 busy，不经代际锁清理 */
  const [recovering, setRecovering] = useState(false)
  /** evict 自动恢复完成计数：同 sid 进程替换不触发 ws/sid 变化，以此驱动上层回读校准（persona 显示） */
  const [recoveryNonce, setRecoveryNonce] = useState(0)

  // ===== chunk rAF 聚合（流式性能护栏②） =====
  // 连续 text/thinking chunk 缓冲后按帧冲刷：每帧至多一次 store set / render。
  // 同步冲刷规则：任何非 chunk 事件处理前先 flush（保事件相对顺序）。
  const chunkBuf = useRef<SequencedEvent[]>([])
  const rafRef = useRef(0)
  const flushChunks = useCallback(() => {
    rafRef.current = 0
    const buf = chunkBuf.current
    if (!buf.length) return
    chunkBuf.current = []
    // 合并相邻同 (event, messageId) 的 delta 为单次 applyEvent（追加语义等价）
    let i = 0
    while (i < buf.length) {
      const first = buf[i]
      const fd = first.data as { messageId: string; delta: string }
      let delta = fd.delta
      let j = i + 1
      while (j < buf.length) {
        const nxt = buf[j]
        const nd = nxt.data as { messageId: string; delta: string }
        if (nxt.event !== first.event || nd.messageId !== fd.messageId) break
        delta += nd.delta
        j++
      }
      applyEvent({
        seq: 0,
        event: first.event,
        data: { messageId: fd.messageId, delta }
      } as SequencedEvent)
      i = j
    }
  }, [applyEvent])

  const dropChunks = useCallback(() => {
    chunkBuf.current.length = 0
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = 0
    }
  }, [])

  const closeSse = useCallback(() => {
    flushChunks() // 末帧 chunk 不丢
    sseRef.current?.close()
    sseRef.current = null
  }, [flushChunks])

  /** evict 自动恢复（多 tab 智能体切换：另一 tab 替换了本会话进程）。旧 ctx 广播 query_closed
   *  时新进程尚在启动，带退避探测：命中本人同 sid 活跃 → 重连 SSE（seq 重置，新 ctx 从头计）；
   *  他人接管 / 探测超时 → 写 closed 落被驱逐横幅兜底（引导手动恢复）。
   *  recovering 独立于 busy：清理不经代际锁，不干扰进行中的其它会话操作 */
  const recoverFromEvict = useCallback(
    (gen: number, workspaceDir: string, sessionId: string) => {
      setRecovering(true)
      void (async () => {
        let recovered = false
        for (const delay of EVICT_RECOVERY_DELAYS) {
          await sleep(delay)
          if (genRef.current !== gen) break // 用户已切走：交由新操作接管
          let res: Awaited<ReturnType<typeof agentApi.getActiveSession>> | null = null
          try {
            res = await agentApi.getActiveSession(workspaceDir)
          } catch {
            /* 探测异常视为未就绪，继续退避 */
          }
          if (genRef.current !== gen) break
          if (res?.active && res.active.sessionId === sessionId) {
            // 切换发生在 idle（本地消息已完整），无需 loadHistory；人格校准由 recoveryNonce 驱动
            dropChunks()
            startSseRef.current(workspaceDir, sessionId)
            setRecoveryNonce((n) => n + 1)
            recovered = true
            break
          }
          if (res?.occupiedBy) break // 工作区被他人接管：真被驱逐，无需再等
        }
        setRecovering(false)
        if (!recovered && genRef.current === gen) {
          useChatStore.setState({ closed: { reason: 'evict' } })
        }
      })()
    },
    [dropChunks]
  )

  const startSse = useCallback(
    (workspaceDir: string, sessionId: string, opts?: { keepSeq?: boolean; sinceSeq?: number }) => {
      closeSse()
      // sinceSeq：以历史快照 seq 为锚增量重放（attach/resume 锚定路径，覆盖 keepSeq）；
      // 默认重置（openNew/evict 恢复是新进程，seq 从头计，全量重放无重复）；
      // keepSeq：同会话重连保留本地游标（服务端全量重放经 seq 幂等过滤零重复）
      if (opts?.sinceSeq !== undefined) lastSeq.current = opts.sinceSeq
      else if (!opts?.keepSeq) lastSeq.current = 0
      const gen = genRef.current
      const sse = openAgentSSE(agentApi.eventsUrl(sessionId, workspaceDir, opts?.sinceSeq), {
        onEvent: (ev) => {
          // 本连接所属代际已被取代（用户已切走）：丢弃事件防写入新会话视图
          if (genRef.current !== gen) return
          // evict（多 tab 智能体切换等进程替换）：尝试无感恢复而非落横幅（onClosed 已断本连接）
          if (
            ev.event === 'query_closed' &&
            (ev.data as { reason: SessionCloseReason }).reason === 'evict'
          ) {
            recoverFromEvict(gen, workspaceDir, sessionId)
            return
          }
          const isChunk = ev.event === 'text_chunk' || ev.event === 'thinking_chunk'
          // 保序：非 chunk 事件处理前同步冲刷缓冲
          if (!isChunk && chunkBuf.current.length) flushChunks()

          // seq 跳跃（已流式过 + 缓冲覆盖不到）→ 历史快照对账，跳过本条防重复。
          // 丢弃缓冲 chunk（对账快照已包含其效果），避免快照后重复追加。
          if (lastSeq.current > 0 && ev.seq > lastSeq.current + 1 && !reconciling.current) {
            dropChunks()
            reconciling.current = true
            void agentApi
              .getMessages(sessionId, workspaceDir)
              .catch(() => null)
              .then((history) => {
                // 对账请求期间用户已切换会话：丢弃迟到快照，复位标志交由新连接接管
                if (genRef.current !== gen) {
                  reconciling.current = false
                  return
                }
                loadHistory(history?.messages ?? [], sessionId)
                lastSeq.current = ev.seq
                applyEvent(ev)
                reconciling.current = false
              })
            return
          }
          if (ev.seq <= lastSeq.current) return
          lastSeq.current = ev.seq

          if (isChunk) {
            chunkBuf.current.push(ev)
            if (!rafRef.current) rafRef.current = requestAnimationFrame(flushChunks)
            return
          }
          applyEvent(ev)
          // 锚定 attach 的自愈刷新（见 pendingHistoryRefresh 声明处注释）：turn_end 时 JSONL 已补全
          if (ev.event === 'turn_end' && pendingHistoryRefresh.current) {
            pendingHistoryRefresh.current = false
            void agentApi
              .getMessages(sessionId, workspaceDir)
              .catch(() => null)
              .then((h) => {
                if (h && genRef.current === gen) loadHistory(h.messages, sessionId)
              })
          }
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
    [applyEvent, loadHistory, closeSse, flushChunks, dropChunks, recoverFromEvict]
  )

  // recoverFromEvict 经此 ref 调最新 startSse 重连（见 sseRef 处声明说明）
  useEffect(() => {
    startSseRef.current = startSse
  }, [startSse])

  // ===== 统一接入 =====

  /** 命中本人活跃会话 → getMessages 全量 loadHistory + 以响应 seq 为锚 SSE 增量重放；
   *  否则返回 false 供调用方 resume */
  const attachActive = useCallback(
    async (workspaceDir: string, sid: string): Promise<boolean> => {
      const gen = ++genRef.current
      const res = await agentApi.getActiveSession(workspaceDir)
      if (genRef.current !== gen) return false
      if (res.active && res.active.sessionId === sid) {
        setWs(workspaceDir)
        setSid(sid)
        const history = await agentApi.getMessages(sid, workspaceDir)
        if (genRef.current !== gen) return false
        loadHistory(history.messages, sid)
        pendingHistoryRefresh.current = true
        // seq null（极窄竞态 ctx 已死）→ 无锚全量重放；ctx 死则 SSE 连不上，重放不会发生
        startSse(workspaceDir, sid, history.seq !== null ? { sinceSeq: history.seq } : undefined)
        return true
      }
      return false
    },
    [startSse, loadHistory]
  )

  /** resume 历史会话（空闲回收/服务重启后无感恢复）；busy 覆盖全程（isSwitchingSession 数据源） */
  const resume = useCallback(
    async (projectId: string, sid: string, evict?: boolean) => {
      const gen = ++genRef.current
      setBusy(true)
      try {
        // 先断老 SSE/丢弃在飞 chunk：防 reset/loadHistory 前老会话事件写入新视图
        closeSse()
        dropChunks()
        const outcome = await agentApi.openSession({
          projectId,
          resumeSessionId: sid,
          ...(evict ? { evict: true } : {})
        })
        if (genRef.current !== gen) return
        setWs(outcome.workspaceDir)
        setSid(outcome.sessionId)
        const history = await agentApi
          .getMessages(outcome.sessionId, outcome.workspaceDir)
          .catch(() => null)
        if (genRef.current !== gen) return
        loadHistory(history?.messages ?? [], outcome.sessionId)
        // 新 ctx seq 从头，锚定（快照后事件增量重放）等价全量且防进程重建竞态下的缓冲重复
        startSse(
          outcome.workspaceDir,
          outcome.sessionId,
          history?.seq != null ? { sinceSeq: history.seq } : undefined
        )
      } finally {
        if (genRef.current === gen) setBusy(false)
      }
    },
    [loadHistory, startSse, closeSse, dropChunks]
  )

  /** 开新会话（可选首条消息）；busy 覆盖全程。personaId 仅在此入口生效（resume 走后端绑定快照） */
  const openNew = useCallback(
    async (
      projectId: string,
      firstMessage?: string,
      evict?: boolean,
      personaId?: string,
      runMode?: RunMode
    ) => {
      const gen = ++genRef.current
      setBusy(true)
      try {
        // 先断老 SSE/丢弃在飞 chunk 再清 store：切断 reset 与 startSse 之间老会话
        // 事件（流式 chunk/evict 广播）经旧连接回流写入新会话视图的窗口
        closeSse()
        dropChunks()
        reset()
        if (runMode) useChatStore.setState({ runMode })
        const outcome = await agentApi.openSession({
          projectId,
          firstMessage,
          ...(personaId ? { personaId } : {}),
          ...(runMode ? { runMode } : {}),
          ...(evict ? { evict: true } : {})
        })
        if (genRef.current !== gen) return null
        setWs(outcome.workspaceDir)
        setSid(outcome.sessionId)
        if (firstMessage) pushLocalUser(firstMessage)
        startSse(outcome.workspaceDir, outcome.sessionId)
        return outcome
      } finally {
        if (genRef.current === gen) setBusy(false)
      }
    },
    [reset, pushLocalUser, startSse, closeSse, dropChunks]
  )

  /** 切换活会话智能体（仅 idle 可切，服务端锁内校验）：进程被替换（evict + 同 sid resume），
   *  历史 JSONL 重放、记忆保留、人格更换；前端后续与 resume 同构——重放历史快照 + 重连 SSE */
  const switchPersona = useCallback(
    async (personaId: string | null) => {
      if (!ws || !sid) return
      const gen = ++genRef.current
      setBusy(true)
      try {
        // 先断老 SSE：旧进程被 evict 关闭时广播 query_closed，防 closed 态误写入本会话视图
        closeSse()
        dropChunks()
        // 以服务端返回为准同步 ws/sid（极罕见情况下 SDK resume 后换 sid，旧值即失联）
        const outcome = await agentApi.switchPersona(sid, ws, personaId)
        if (genRef.current !== gen) return
        setWs(outcome.workspaceDir)
        setSid(outcome.sessionId)
        const history = await agentApi
          .getMessages(outcome.sessionId, outcome.workspaceDir)
          .catch(() => null)
        if (genRef.current !== gen) return
        loadHistory(history?.messages ?? [], outcome.sessionId)
        startSse(
          outcome.workspaceDir,
          outcome.sessionId,
          history?.seq != null ? { sinceSeq: history.seq } : undefined
        )
      } finally {
        if (genRef.current === gen) setBusy(false)
      }
    },
    [ws, sid, loadHistory, startSse, closeSse, dropChunks]
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

  /** 热切换执行模式（不重启进程；store 由 SSE run_mode 事件回灌校准） */
  const setRunMode = useCallback(
    async (mode: RunMode) => {
      if (!ws || !sid) return
      await agentApi.setRunMode(sid, ws, mode)
    },
    [ws, sid]
  )

  /** 回滚文件到 checkpoint（user message uuid），随后重载历史 */
  const rewind = useCallback(
    async (messageId: string) => {
      if (!ws || !sid) return
      await agentApi.rewind(sid, ws, messageId)
      const history = await agentApi.getMessages(sid, ws).catch(() => null)
      loadHistory(history?.messages ?? [], sid)
    },
    [ws, sid, loadHistory]
  )

  const closeSession = useCallback(async () => {
    if (!ws || !sid) return
    // gen++ 使在飞 resume/openNew 的 finally 跳过 setBusy(false)（由取代者负责），
    // closeSession 是终结者而非新操作 → 必须就地兜底，否则 busy 永久泄漏
    genRef.current++
    setBusy(false)
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
    recovering,
    recoveryNonce,
    attachActive,
    resume,
    openNew,
    switchPersona,
    send,
    approve,
    interrupt,
    setRunMode,
    rewind,
    closeSession
  }
}

export type { ApiError }
