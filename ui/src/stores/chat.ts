import { create } from 'zustand'
import type {
  AgentStatus,
  ChatMessage,
  ContentBlock,
  PendingApproval,
  SequencedEvent,
  SessionCloseReason,
  SubagentInfo,
  Usage
} from '@/lib/agent-types'

/**
 * 聊天会话状态机 —— SSE 事件累积与历史回放落到同一 messages 结构。
 * useChatAgent 把后端事件喂给 applyEvent，UI 只读 selectors。
 *
 * 渲染正确性不变量：
 * - text_chunk/thinking_chunk O(1) 追加到目标 assistant 末尾（同类型 block 合并）
 * - tool_call_args 增量累积到 buf，tool_call_end 时 JSON.parse 写回 input
 * - tool_result 按 toolCallId 回填到对应 tool_use block（跨消息查找）
 * - approval_settled 移除挂起卡并固化 outcome（历史回放时已答卡由 tool_result 呈现）
 */

interface ChatState {
  sessionId: string | null
  status: AgentStatus
  messages: ChatMessage[]
  approvals: PendingApproval[]
  /** 已终结审批 outcome（供卡片固化展示；toolCallId → outcome） */
  settled: Record<string, { outcome: string; reason?: string }>
  usage: Usage | null
  closed: { reason: SessionCloseReason } | null
  /** 最近一次 checkpoint（user message uuid，用于 rewindFiles 回滚） */
  lastCheckpoint: string | null
  /** 活跃子代理进度（按 toolUseId 内联到对应 tool_use block 渲染；done 即移除） */
  subagentByToolUse: Record<string, SubagentInfo>
  /** toolCallId → 待解析参数缓冲（tool_call_end 时 JSON.parse） */
  toolArgBuf: Record<string, string>
  /** messageId → messages 下标（流式 chunk O(1) 定位） */
  messageIndex: Record<string, number>
  /** toolCallId → { msgIdx, blockIdx }（tool_result 回填定位） */
  toolUsePos: Record<string, { msgIdx: number; blockIdx: number }>

  /** 重置（切换会话/退出） */
  reset: () => void
  /** 历史快照整段替换（断线重连兜底 / 首次加载） */
  loadHistory: (msgs: ChatMessage[], sessionId: string) => void
  /** 应用一条 SSE 事件 */
  applyEvent: (ev: SequencedEvent) => void
  /** 推入一条本地用户消息（发消息即时上屏，乐观更新） */
  pushLocalUser: (text: string) => string
}

function lastBlock(msg: ChatMessage): ContentBlock | undefined {
  if (msg.type !== 'assistant') return undefined
  return msg.content[msg.content.length - 1]
}

export const useChatStore = create<ChatState>((set, get) => ({
  sessionId: null,
  status: 'idle',
  messages: [],
  approvals: [],
  settled: {},
  usage: null,
  closed: null,
  lastCheckpoint: null,
  subagentByToolUse: {},
  toolArgBuf: {},
  messageIndex: {},
  toolUsePos: {},

  reset: () =>
    set({
      sessionId: null,
      status: 'idle',
      messages: [],
      approvals: [],
      settled: {},
      usage: null,
      closed: null,
      subagentByToolUse: {},
      toolArgBuf: {},
      messageIndex: {},
      toolUsePos: {}
    }),

  loadHistory: (msgs, sessionId) =>
    set(() => {
      const messageIndex: Record<string, number> = {}
      const toolUsePos: Record<string, { msgIdx: number; blockIdx: number }> = {}
      msgs.forEach((m, mi) => {
        messageIndex[m.id] = mi
        if (m.type === 'assistant') {
          m.content.forEach((b, bi) => {
            if (b.type === 'tool_use') toolUsePos[b.id] = { msgIdx: mi, blockIdx: bi }
          })
        }
      })
      return { messages: msgs, messageIndex, toolUsePos, sessionId, status: 'idle' as const }
    }),

  pushLocalUser: (text) => {
    const id = `local-${crypto.randomUUID()}`
    set((s) => ({
      messages: [...s.messages, { type: 'user', id, content: text }],
      messageIndex: { ...s.messageIndex, [id]: s.messages.length },
      status: 'thinking' as const
    }))
    return id
  },

  applyEvent: (ev) => {
    const s = get()
    const { event, data } = ev

    if (event === 'session') {
      set({ sessionId: (data as { sessionId: string }).sessionId })
      return
    }
    if (event === 'status') {
      set({ status: (data as { status: AgentStatus }).status })
      return
    }
    if (event === 'usage') {
      set({ usage: data as Usage })
      return
    }
    if (event === 'checkpoint') {
      set({ lastCheckpoint: (data as { uuid: string }).uuid })
      return
    }
    if (event === 'subagent_progress') {
      const info = data as SubagentInfo
      const key = info.toolUseId
      // 仅跟踪带 toolUseId 的子代理（无 id 的 ambient 任务不内联到任何 block）
      if (!key) return
      set((st) => {
        if (info.phase === 'done') {
          const { [key]: _omit, ...rest } = st.subagentByToolUse
          return { subagentByToolUse: rest }
        }
        return { subagentByToolUse: { ...st.subagentByToolUse, [key]: info } }
      })
      return
    }
    if (event === 'query_closed') {
      set({ closed: { reason: (data as { reason: SessionCloseReason }).reason } })
      return
    }
    if (event === 'approval_request') {
      const p = data as PendingApproval
      if (!s.approvals.some((a) => a.toolCallId === p.toolCallId)) {
        set({ approvals: [...s.approvals, p] })
      }
      return
    }
    if (event === 'approval_settled') {
      const d = data as { toolCallId: string; outcome: string; reason?: string }
      set({
        approvals: s.approvals.filter((a) => a.toolCallId !== d.toolCallId),
        settled: {
          ...s.settled,
          [d.toolCallId]: { outcome: d.outcome, ...(d.reason ? { reason: d.reason } : {}) }
        }
      })
      return
    }
    if (event === 'turn_end') {
      set({ status: 'idle' })
      return
    }
    if (event === 'error') {
      set({ status: 'error' })
      const id = `err-${crypto.randomUUID()}`
      set((st) => ({
        messages: [
          ...st.messages,
          { type: 'system', id, content: (data as { message: string }).message, level: 'error' }
        ],
        messageIndex: { ...st.messageIndex, [id]: st.messages.length }
      }))
      return
    }

    // 以下事件操作 messages 数组
    const messages = s.messages
    const messageIndex = s.messageIndex
    const toolArgBuf = s.toolArgBuf
    const toolUsePos = s.toolUsePos

    if (event === 'message_start') {
      const id = (data as { messageId: string }).messageId
      const msg: ChatMessage = { type: 'assistant', id, content: [] }
      set({
        messages: [...messages, msg],
        messageIndex: { ...messageIndex, [id]: messages.length },
        status: 'thinking'
      })
      return
    }

    if (event === 'text_chunk' || event === 'thinking_chunk') {
      const d = data as { messageId: string; delta: string }
      const mi = messageIndex[d.messageId]
      if (mi === undefined) return
      const msg = messages[mi]
      if (msg?.type !== 'assistant') return
      const blockType = event === 'text_chunk' ? 'text' : 'thinking'
      const last = lastBlock(msg)
      let content: ContentBlock[]
      if (last && last.type === blockType) {
        content = [...msg.content.slice(0, -1), { type: blockType, text: last.text + d.delta }]
      } else {
        content = [...msg.content, { type: blockType, text: d.delta }]
      }
      const next = [...messages]
      next[mi] = { ...msg, content }
      set({ messages: next, status: 'responding' })
      return
    }

    if (event === 'tool_call_start') {
      const d = data as { toolCallId: string; name: string; messageId: string }
      const mi = messageIndex[d.messageId]
      if (mi === undefined) return
      const msg = messages[mi]
      if (msg?.type !== 'assistant') return
      const blockIdx = msg.content.length
      const block: ContentBlock = { type: 'tool_use', id: d.toolCallId, name: d.name, input: {} }
      const next = [...messages]
      next[mi] = { ...msg, content: [...msg.content, block] }
      set({
        messages: next,
        toolUsePos: { ...toolUsePos, [d.toolCallId]: { msgIdx: mi, blockIdx } },
        status: 'tool-use'
      })
      return
    }

    if (event === 'tool_call_args') {
      const d = data as { toolCallId: string; delta: string }
      set({
        toolArgBuf: { ...toolArgBuf, [d.toolCallId]: (toolArgBuf[d.toolCallId] ?? '') + d.delta }
      })
      return
    }

    if (event === 'tool_call_end') {
      const d = data as { toolCallId: string }
      const pos = toolUsePos[d.toolCallId]
      if (!pos) return
      const buf = toolArgBuf[d.toolCallId] ?? ''
      let input: Record<string, unknown> = {}
      if (buf) {
        try {
          input = JSON.parse(buf) as Record<string, unknown>
        } catch {
          input = { _raw: buf }
        }
      }
      const msg = messages[pos.msgIdx]
      if (msg?.type !== 'assistant') return
      const block = msg.content[pos.blockIdx]
      if (block?.type !== 'tool_use') return
      const next = [...messages]
      next[pos.msgIdx] = {
        ...msg,
        content: [
          ...msg.content.slice(0, pos.blockIdx),
          { ...block, input },
          ...msg.content.slice(pos.blockIdx + 1)
        ]
      }
      const { [d.toolCallId]: _omit, ...restBuf } = toolArgBuf
      set({ messages: next, toolArgBuf: restBuf })
      return
    }

    if (event === 'tool_result') {
      const d = data as {
        toolCallId: string
        content: string
        error?: boolean
        toolUseResult?: unknown
      }
      const pos = toolUsePos[d.toolCallId]
      if (!pos) return
      const msg = messages[pos.msgIdx]
      if (msg?.type !== 'assistant') return
      const block = msg.content[pos.blockIdx]
      if (block?.type !== 'tool_use') return
      const next = [...messages]
      next[pos.msgIdx] = {
        ...msg,
        content: [
          ...msg.content.slice(0, pos.blockIdx),
          {
            ...block,
            result: d.content,
            ...(d.error ? { resultError: true } : {}),
            ...(d.toolUseResult !== undefined ? { toolUseResult: d.toolUseResult } : {})
          },
          ...msg.content.slice(pos.blockIdx + 1)
        ]
      }
      set({ messages: next })
      return
    }

    if (event === 'message_end') {
      const d = data as { messageId: string; partial?: boolean }
      const mi = messageIndex[d.messageId]
      if (mi === undefined) return
      const msg = messages[mi]
      if (msg?.type !== 'assistant') return
      const next = [...messages]
      next[mi] = { ...msg, ...(d.partial ? { partial: true } : {}) }
      set({ messages: next })
      return
    }

    // compaction / context_usage / commands / checkpoint：M2 暂不渲染（M3 扩展）
  }
}))
