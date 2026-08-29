/**
 * agent 域前端类型镜像 —— 与后端 src/modules/agent/sse-events.ts 同构。
 * SSE 实时流与 GET /session/messages 历史回放落到同一 ChatMessage 结构，
 * 保证渲染走同一条代码路径。
 */

export type ChatMessage = UserMessage | AssistantMessage | SystemMessage | CompactionDividerMessage

export interface UserMessage {
  type: 'user'
  id: string
  content: string
}

export interface AssistantMessage {
  type: 'assistant'
  id: string
  content: ContentBlock[]
  /** turn 被 abort 时为 true，表示文本可能不完整 */
  partial?: boolean
}

export interface SystemMessage {
  type: 'system'
  id: string
  content: string
  level?: 'interrupt' | 'error' | 'info'
}

export interface CompactionDividerMessage {
  type: 'compaction'
  id: string
  trigger: 'manual' | 'auto'
  preTokens: number
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | {
      type: 'tool_use'
      id: string
      name: string
      input: Record<string, unknown>
      result?: string
      resultError?: boolean
      toolUseResult?: unknown
    }

export type AgentStatus =
  'idle' | 'thinking' | 'responding' | 'tool-use' | 'awaiting-approval' | 'error'

export type ApprovalOutcome = 'allow' | 'deny' | 'timeout' | 'closed'

export interface Usage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  totalCostUsd?: number
  durationMs?: number
  durationApiMs?: number
}

/** 子代理（Task/Agent 工具）运行进度 */
export interface SubagentInfo {
  taskId: string
  toolUseId?: string
  phase: 'started' | 'progress' | 'done'
  description: string
  subagentType?: string
  lastToolName?: string
  summary?: string
  status?: 'completed' | 'failed' | 'stopped'
}

export interface PendingApproval {
  toolCallId: string
  toolName: string
  input: Record<string, unknown>
  suggestions?: unknown[]
  /** 过期时刻（ms 时间戳），前端据此恢复倒计时 */
  expiresAt: number
}

/** 审批卡片入参形状（PermissionRequest 组件只读 toolName/input，与 PendingApproval 兼容） */
export type ApprovalRequest = PendingApproval

/** composer 附件：@file 引用（随文本下发）或图片（dataURL） */
export type Attachment =
  | { type: 'file'; path: string }
  | { type: 'image'; dataUrl: string; mime: string; filename?: string }

/** SSE 事件（与后端 SSEEvent 同构；带 seq 后为线上格式） */
export type SSEEvent =
  | { event: 'session'; data: { sessionId: string } }
  | { event: 'commands'; data: { commands: SlashCommand[] } }
  | { event: 'status'; data: { status: AgentStatus } }
  | { event: 'message_start'; data: { messageId: string } }
  | { event: 'text_chunk'; data: { messageId: string; delta: string } }
  | { event: 'thinking_chunk'; data: { messageId: string; delta: string } }
  | { event: 'tool_call_start'; data: { toolCallId: string; name: string; messageId: string } }
  | { event: 'tool_call_args'; data: { toolCallId: string; delta: string } }
  | { event: 'tool_call_end'; data: { toolCallId: string } }
  | {
      event: 'tool_result'
      data: { toolCallId: string; content: string; error?: boolean; toolUseResult?: unknown }
    }
  | { event: 'approval_request'; data: PendingApproval }
  | {
      event: 'approval_settled'
      data: { toolCallId: string; outcome: ApprovalOutcome; reason?: string }
    }
  | { event: 'checkpoint'; data: { uuid: string } }
  | { event: 'message_end'; data: { messageId: string; partial?: boolean } }
  | { event: 'usage'; data: Usage }
  | { event: 'subagent_progress'; data: SubagentInfo }
  | { event: 'context_usage'; data: { context: ContextUsage } }
  | {
      event: 'compaction'
      data: { phase: 'start' | 'end'; trigger?: 'manual' | 'auto'; preTokens?: number }
    }
  | { event: 'error'; data: { message: string } }
  | { event: 'turn_end'; data: { partial: boolean } }
  | { event: 'query_closed'; data: { reason: SessionCloseReason } }

export type SessionCloseReason =
  | 'user_close'
  | 'idle_gc'
  | 'logout'
  | 'evict'
  | 'life_limit'
  | 'shutdown'
  | 'error'
  | 'process_exit'

export interface SequencedEvent {
  seq: number
  event: SSEEvent['event']
  data: SSEEvent['data']
}

export interface SlashCommand {
  name: string
  description: string
  argumentHint: string
  aliases?: string[]
}

export interface ContextUsage {
  categories: { name: string; tokens: number; color: string; isDeferred?: boolean }[]
  totalTokens: number
  maxTokens: number
  percentage: number
  model: string
}

export interface Project {
  id: string
  name: string
  path: string
  createdBy: string
  createdAt: string
}

/** 智能体定义（可复用人格；systemPrompt 追加注入会话） */
export interface Persona {
  id: string
  name: string
  description: string
  systemPrompt: string
  createdAt: string
  updatedAt: string
}

export interface SessionSummary {
  id: string
  summary: string
  title: string
  lastModified: number
  gitBranch: string
  cwd: string
  fileSize: number
  createdAt: number
  /** 会话当前存活（有活跃进程） */
  live: boolean
  /** 会话绑定的智能体名快照（无绑定则缺省 = 标准 Claude） */
  personaName?: string
}

export interface ActiveSession {
  sessionId: string
  state: 'starting' | 'idle' | 'turn-running' | 'closing' | 'closed'
  startedAt: number
  turns: number
  /** 会话绑定的智能体 id（绑定快照事实源；无绑定则缺省 = 标准 Claude） */
  personaId?: string
  /** 绑定名快照（persona 事后增删改不影响此值） */
  personaName?: string
  /** 会话当前生效的 append 系统提示词（最后切换值；标准 Claude 缺省） */
  systemPrompt?: string
}

export interface ActiveSessionResult {
  active: ActiveSession | null
  occupiedBy?: { username: string; sessionId: string; state: string; idleMinutes: number }
}

export interface OccupiedInfo {
  username: string
  sessionId: string
  state: string
  idleMinutes: number
}

// ===== 看板统计 =====

export interface StatsData {
  active: {
    sessions: number
    users: number
    byState: Record<string, number>
    byUser: Array<{ username: string; count: number }>
    inputTokens: number
    outputTokens: number
  }
  historical: {
    totalSessions: number
    todaySessions: number
    totalInputTokens: number
    totalOutputTokens: number
    byCloseReason: Record<string, number>
  }
  projects: number
  registeredUsers: number
}
