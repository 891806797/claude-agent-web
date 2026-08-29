import type { PendingApproval, SequencedEvent, SessionCloseReason } from './agent-types'

/**
 * EventSource 封装：sid/ws 走 query（EventSource 不支持自定义 header）。
 *
 * seq 幂等：服务端为每个有序事件写 `id: <seq>`，EventSource 通过
 * e.lastEventId 暴露本条 id——据此还原 SequencedEvent。无 id 的事件仅
 * approval_request 重放（前端按 toolCallId 幂等合并）。
 * EventSource 原生断线重连并自动携带 Last-Event-ID（服务端增量重放）。
 */
const EVENT_NAMES = [
  'session',
  'commands',
  'status',
  'message_start',
  'text_chunk',
  'thinking_chunk',
  'tool_call_start',
  'tool_call_args',
  'tool_call_end',
  'tool_result',
  'approval_request',
  'approval_settled',
  'checkpoint',
  'message_end',
  'usage',
  'context_usage',
  'compaction',
  'error',
  'turn_end',
  'query_closed'
] as const

export interface SseHandlers {
  onEvent: (ev: SequencedEvent) => void
  /** approval_request 重放（无 seq，按 toolCallId 幂等合并） */
  onApprovalReplay?: (p: PendingApproval) => void
  onPing?: () => void
  onOpen?: () => void
  onClosed?: (reason: SessionCloseReason) => void
  /** 连接异常（EventSource 会自动重连） */
  onError?: () => void
}

export interface AgentSSE {
  close: () => void
}

export function openAgentSSE(url: string, h: SseHandlers): AgentSSE {
  const source = new EventSource(url)

  for (const name of EVENT_NAMES) {
    source.addEventListener(name, (e) => {
      const me = e as MessageEvent
      const rawId = me.lastEventId
      const seq = rawId ? Number.parseInt(rawId, 10) : NaN
      let data: unknown
      try {
        data = JSON.parse(me.data)
      } catch {
        data = {}
      }
      if (Number.isNaN(seq)) {
        // 无 id：仅 approval_request 重放走此路径（前端按 toolCallId 幂等合并）
        if (name === 'approval_request') h.onApprovalReplay?.(data as PendingApproval)
        return
      }
      if (name === 'query_closed') {
        h.onClosed?.((data as { reason: SessionCloseReason }).reason)
      }
      h.onEvent({ seq, event: name, data } as unknown as SequencedEvent)
    })
  }

  source.addEventListener('ping', () => h.onPing?.())
  source.addEventListener('open', () => h.onOpen?.())
  source.addEventListener('error', () => h.onError?.())

  return { close: () => source.close() }
}
