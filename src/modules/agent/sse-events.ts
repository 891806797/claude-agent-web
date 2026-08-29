/**
 * agent 模块 SSE 协议类型（后端权威定义；前端 ui/src/lib/agent-types.ts 镜像同一形状）。
 * 移植自 claude-agent-desktop src/shared/types.ts，web 版三处扩展：
 * - tool_result 携带 tool_use_result 结构化旁挂（SDK 文档：AgentOutput 等应从该字段呈现，文本仅兜底）
 * - approval_settled：审批/问卷以任何方式终结（作答/超时/会话关闭）都广播——双 tab 一致性靠它
 * - query_closed 携带 reason（前端据 reason 决定停重连/提示"已空闲回收"等）
 */

// ===== 消息类型（前端展示权威；流式累积与历史恢复落到同一结构）=====

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

/** 上下文压缩边界分隔符：此消息之上的早期消息已被摘要替换 */
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
      /** SDK 结构化工具输出旁挂（渲染优先于 result 文本） */
      toolUseResult?: unknown
    }

// ===== Agent 状态 =====

export type AgentStatus =
  | 'idle'
  | 'thinking'
  | 'responding'
  | 'tool-use'
  | 'awaiting-approval'
  | 'error'

// ===== 审批 =====

export interface ApprovalResponse {
  toolCallId: string
  allowed: boolean
  /** 允许时用户可修改工具参数（服务端按字段白名单校验：仅 Bash/PowerShell 的 command） */
  modifiedInput?: Record<string, unknown>
  /** 拒绝时的反馈理由 */
  feedback?: string
  /** 记住选择：本次会话对该 toolName 总是允许 */
  alwaysAllow?: boolean
}

export type ApprovalOutcome = 'allow' | 'deny' | 'timeout' | 'closed'

// ===== 会话关闭原因（agent_session_stats.closeReason 同集）=====

export type SessionCloseReason =
  | 'user_close'
  | 'idle_gc'
  | 'logout'
  | 'evict'
  | 'life_limit'
  | 'shutdown'
  | 'error'
  | 'process_exit'

// ===== SSE 事件（后端 → 前端；每条事件在会话内带单调递增 seq）=====

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
  memoryFiles: { path: string; type: string; tokens: number }[]
  mcpTools: { name: string; serverName: string; tokens: number }[]
  autoCompactThreshold?: number
  isAutoCompactEnabled?: boolean
}

export interface ModelInfo {
  value: string
  displayName: string
  description: string
  supportsEffort?: boolean
}

export interface Usage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  totalCostUsd?: number
  durationMs?: number
  durationApiMs?: number
}

/** 子代理（Task/Agent 工具）运行进度（SDK task_* system 消息翻译） */
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
  | {
      event: 'approval_request'
      data: {
        toolCallId: string
        toolName: string
        input: Record<string, unknown>
        suggestions?: unknown[]
        /** 审批过期时刻（ms 时间戳）；SSE 重放恢复倒计时用 */
        expiresAt: number
      }
    }
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

// ===== 会话摘要（列表接口返回）=====

export interface SanitizedSession {
  id: string
  summary: string
  title: string
  lastModified: number
  gitBranch: string
  cwd: string
  fileSize: number
  createdAt: number
}

/** 会话事件带 seq 后的线上格式（SSE data 字段 JSON，event 与 data 保持联合关联） */
export type SequencedEvent = { seq: number } & SSEEvent
