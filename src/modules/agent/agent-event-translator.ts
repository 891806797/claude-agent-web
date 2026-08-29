import type { Logger } from 'pino'
import type { ContextUsage, SlashCommand, SSEEvent, SubagentInfo, Usage } from './sse-events'

/**
 * SDK 消息流 → SSEEvent 翻译循环（移植自 desktop translateStreamPersistent）。
 *
 * streaming-input 常驻会话的多 turn 消费：
 * - system 分支：session_id 首见即回调（SessionStart hook 早于 init 到达且已带 sid）
 * - stream_event 分支：partial 流式块 → message_start/text_chunk/thinking_chunk/tool_call_*
 * - user 分支：tool_result（含 tool_use_result 结构化旁挂）+ checkpoint
 * - result 分支：usage + context_usage → turn_end 后 continue（不 return，消费多 turn）
 * - for-await 退出（abort 或子进程退出）→ onStreamEnd 由 registry 决定 query_closed 语义
 */

export interface TranslateHandlers {
  onEvent: (ev: SSEEvent) => void
  /** 首次拿到 session_id（registry 用于与预置 id 对账纠偏） */
  onSessionId: (sid: string) => void
  /** 翻译循环退出（唯一出口）；registry 在此广播 query_closed + 清理 */
  onStreamEnd: () => void
  abortController: AbortController
  sessionLogger: Logger
}

/** SDK 流对象（Query）：可迭代 + 可选的 context usage 查询 */
type SDKStreamObject = AsyncIterable<unknown> & {
  getContextUsage?: () => Promise<unknown>
}

export async function translateSessionStream(
  messageStream: SDKStreamObject,
  handlers: TranslateHandlers,
): Promise<void> {
  const { onEvent, sessionLogger, abortController } = handlers
  let sessionResolved = false
  let messageCount = 0
  let currentMessageId: string | null = null
  let hasStreamedText = false
  let currentToolCallId: string | null = null

  const finishMessage = (partial: boolean): void => {
    if (currentMessageId && hasStreamedText) {
      onEvent({
        event: 'message_end',
        data: { messageId: currentMessageId, ...(partial ? { partial } : {}) },
      })
    }
    currentMessageId = null
    hasStreamedText = false
  }

  const pushContextUsage = async (): Promise<void> => {
    if (typeof messageStream.getContextUsage !== 'function') return
    try {
      const ctx = await Promise.race([
        messageStream.getContextUsage(),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('context_usage timeout')), 5000).unref()
        }),
      ])
      onEvent({ event: 'context_usage', data: { context: toContextUsageDTO(ctx) } })
    } catch {
      /* getContextUsage 失败/超时不影响主流程 */
    }
  }

  try {
    for await (const rawMessage of messageStream) {
      const message = rawMessage as Record<string, unknown>
      if (++messageCount === 1) {
        sessionLogger.info(
          { subtype: String(message.subtype ?? '') },
          'SDK 流首条消息到达（openSession 超时诊断锚点）',
        )
      }

      if (message.type === 'system') {
        const subtype = message.subtype as string | undefined

        // 首见 session_id 即回调（CLI 0.3.250 起首条用户消息前零输出，init 随首条输入到达）
        if (!sessionResolved) {
          const sidFromMsg = extractSessionId(message)
          if (sidFromMsg) {
            sessionResolved = true
            handlers.onSessionId(sidFromMsg)
            onEvent({ event: 'session', data: { sessionId: sidFromMsg } })
          }
        }

        if (subtype === 'commands_changed') {
          const cmds = (message.commands as unknown[] | undefined) ?? []
          onEvent({ event: 'commands', data: { commands: cmds.map(toSlashCommandDTO) } })
        } else if (subtype === 'status' && message.status === 'compacting') {
          onEvent({ event: 'compaction', data: { phase: 'start' } })
        } else if (subtype === 'compact_boundary') {
          const meta = (message.compact_metadata ?? message.compactMetadata ?? {}) as {
            trigger?: string
            pre_tokens?: number
            preTokens?: number
          }
          const trigger = meta.trigger === 'manual' ? 'manual' : 'auto'
          const preTokens =
            typeof meta.pre_tokens === 'number'
              ? meta.pre_tokens
              : typeof meta.preTokens === 'number'
                ? meta.preTokens
                : 0
          onEvent({ event: 'compaction', data: { phase: 'end', trigger, preTokens } })
          await pushContextUsage()
        } else if (
          subtype === 'task_started' ||
          subtype === 'task_progress' ||
          subtype === 'task_notification' ||
          subtype === 'task_updated'
        ) {
          // 子代理（Task/Agent 工具）进度；agentProgressSummaries:true 才会到达
          const info = toSubagentDTO(message, subtype)
          if (info) onEvent({ event: 'subagent_progress', data: info })
        }
        // init / thinking_tokens 等其余 subtype：sid 已在上面处理，无需翻译
        continue
      }

      if (message.type === 'stream_event') {
        const event = (message as { event: Record<string, unknown> }).event
        const eventType = event.type as string

        if (eventType === 'message_start') {
          currentMessageId = crypto.randomUUID()
          hasStreamedText = false
          onEvent({ event: 'message_start', data: { messageId: currentMessageId } })
          onEvent({ event: 'status', data: { status: 'thinking' } })
        } else if (eventType === 'content_block_start') {
          const block = (event.content_block ?? {}) as { type?: string; id?: string; name?: string }
          if (block.type === 'thinking') {
            onEvent({ event: 'status', data: { status: 'thinking' } })
          } else if (block.type === 'text') {
            onEvent({ event: 'status', data: { status: 'responding' } })
          } else if (block.type === 'tool_use' && block.id) {
            currentToolCallId = block.id
            onEvent({ event: 'status', data: { status: 'tool-use' } })
            onEvent({
              event: 'tool_call_start',
              data: {
                toolCallId: block.id,
                name: block.name ?? 'unknown',
                messageId: currentMessageId ?? '',
              },
            })
          }
        } else if (eventType === 'content_block_delta') {
          const delta = (event.delta ?? {}) as {
            type?: string
            text?: string
            thinking?: string
            partial_json?: string
          }
          if (delta.type === 'text_delta' && delta.text && currentMessageId) {
            hasStreamedText = true
            onEvent({
              event: 'text_chunk',
              data: { messageId: currentMessageId, delta: delta.text },
            })
          } else if (delta.type === 'thinking_delta' && delta.thinking && currentMessageId) {
            onEvent({
              event: 'thinking_chunk',
              data: { messageId: currentMessageId, delta: delta.thinking },
            })
          } else if (delta.type === 'input_json_delta' && delta.partial_json && currentToolCallId) {
            onEvent({
              event: 'tool_call_args',
              data: { toolCallId: currentToolCallId, delta: delta.partial_json },
            })
          }
        } else if (eventType === 'content_block_stop') {
          const block = (event.content_block ?? {}) as { type?: string }
          if (block.type === 'tool_use' && currentToolCallId) {
            onEvent({ event: 'tool_call_end', data: { toolCallId: currentToolCallId } })
            currentToolCallId = null
            onEvent({ event: 'status', data: { status: 'thinking' } })
          }
        } else if (eventType === 'message_stop') {
          finishMessage(false)
        }
        continue
      }

      if (message.type === 'user') {
        const uuid = (message as { uuid?: string }).uuid
        if (uuid) {
          onEvent({ event: 'checkpoint', data: { uuid } })
        }
        const rawContent = (message.message as { content?: unknown } | undefined)?.content
        if (Array.isArray(rawContent)) {
          const blocks = rawContent as Array<Record<string, unknown>>
          const toolResults = blocks.filter((b) => b.type === 'tool_result' && b.tool_use_id)
          // tool_use_result 为单数旁挂：仅在该消息恰含一条 tool_result 时挂上（多工具时前端用文本兜底）
          const toolUseResult = (message as { tool_use_result?: unknown }).tool_use_result
          const attachable = toolResults.length === 1 && toolUseResult !== undefined
          for (const b of toolResults) {
            onEvent({
              event: 'tool_result',
              data: {
                toolCallId: b.tool_use_id as string,
                content:
                  typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? ''),
                ...(b.is_error ? { error: true } : {}),
                ...(attachable ? { toolUseResult } : {}),
              },
            })
          }
        }
        continue
      }

      if (message.type === 'result') {
        const m = message as {
          is_error?: boolean
          duration_ms?: number
          duration_api_ms?: number
          total_cost_usd?: number
          usage?: Record<string, number>
        }
        const usage = m.usage ?? {}
        const u: Usage = {
          inputTokens: usage.input_tokens ?? 0,
          outputTokens: usage.output_tokens ?? 0,
          cacheReadTokens: usage.cache_read_input_tokens ?? 0,
          cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
          ...(m.total_cost_usd != null ? { totalCostUsd: m.total_cost_usd } : {}),
          ...(m.duration_ms != null ? { durationMs: m.duration_ms } : {}),
          ...(m.duration_api_ms != null ? { durationApiMs: m.duration_api_ms } : {}),
        }
        onEvent({ event: 'usage', data: u })
        await pushContextUsage()
        // 多 turn：turn_end 后 continue；interrupt 不 abort（partial=false），close abort（partial=true）
        finishMessage(abortController.signal.aborted)
        onEvent({ event: 'status', data: { status: m.is_error ? 'error' : 'idle' } })
        onEvent({ event: 'turn_end', data: { partial: abortController.signal.aborted } })
        currentToolCallId = null
      }
    }
  } catch (error) {
    // abort（关会话）：不报 error 事件；其它异常上抛由 registry 发 error
    finishMessage(abortController.signal.aborted)
    throw error
  } finally {
    sessionLogger.info({ messageCount }, 'SDK 翻译循环退出')
    handlers.onStreamEnd()
  }
}

function extractSessionId(message: Record<string, unknown>): string {
  return (
    (message.session_id as string | undefined) ??
    (message.data as { session_id?: string } | undefined)?.session_id ??
    ''
  )
}

function toSlashCommandDTO(c: unknown): SlashCommand {
  const cmd = (c ?? {}) as Record<string, unknown>
  return {
    name: String(cmd.name ?? ''),
    description: String(cmd.description ?? ''),
    argumentHint: String(cmd.argumentHint ?? ''),
    ...(Array.isArray(cmd.aliases) ? { aliases: cmd.aliases.map((a) => String(a)) } : {}),
  }
}

/** SDK task_* system 消息 → SubagentInfo（phase 由 subtype 决定） */
function toSubagentDTO(message: Record<string, unknown>, subtype: string): SubagentInfo | null {
  const taskId = message.task_id
  if (typeof taskId !== 'string') return null
  const str = (k: string): string | undefined => {
    const v = message[k]
    return typeof v === 'string' ? v : undefined
  }
  const phase =
    subtype === 'task_started' ? 'started' : subtype === 'task_notification' ? 'done' : 'progress'
  const status = str('status') as SubagentInfo['status'] | undefined
  return {
    taskId,
    ...(str('tool_use_id') ? { toolUseId: str('tool_use_id') } : {}),
    phase,
    description: str('description') ?? '',
    ...(str('subagent_type') ? { subagentType: str('subagent_type') } : {}),
    ...(str('last_tool_name') ? { lastToolName: str('last_tool_name') } : {}),
    ...(str('summary') ? { summary: str('summary') } : {}),
    ...(status ? { status } : {}),
  }
}

function toContextUsageDTO(c: unknown): ContextUsage {
  const r = (c ?? {}) as Record<string, unknown>
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  const rec = (x: unknown): Record<string, unknown> => (x ?? {}) as Record<string, unknown>
  return {
    categories: Array.isArray(r.categories)
      ? r.categories.map((x) => {
          const a = rec(x)
          return {
            name: str(a.name),
            tokens: num(a.tokens),
            color: str(a.color),
            ...(a.isDeferred ? { isDeferred: true } : {}),
          }
        })
      : [],
    totalTokens: num(r.totalTokens),
    maxTokens: num(r.maxTokens),
    percentage: num(r.percentage),
    model: str(r.model),
    memoryFiles: Array.isArray(r.memoryFiles)
      ? r.memoryFiles.map((x) => {
          const a = rec(x)
          return { path: str(a.path), type: str(a.type), tokens: num(a.tokens) }
        })
      : [],
    mcpTools: Array.isArray(r.mcpTools)
      ? r.mcpTools.map((x) => {
          const a = rec(x)
          return { name: str(a.name), serverName: str(a.serverName), tokens: num(a.tokens) }
        })
      : [],
    ...(typeof r.autoCompactThreshold === 'number' && Number.isFinite(r.autoCompactThreshold)
      ? { autoCompactThreshold: r.autoCompactThreshold }
      : {}),
    ...(typeof r.isAutoCompactEnabled === 'boolean'
      ? { isAutoCompactEnabled: r.isAutoCompactEnabled }
      : {}),
  }
}
