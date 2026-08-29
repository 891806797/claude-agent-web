import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArchiveIcon,
  ArrowDownIcon,
  ChevronRightIcon,
  CheckIcon,
  Loader,
  Loader2Icon,
  Undo2Icon
} from 'lucide-react'
import { ChatInput } from './chat-input'
import { Markdown } from './Markdown'
import { UsageGuide } from './UsageGuide'
import { PermissionRequest } from './PermissionRequest'
import { GUTTER, GUTTER_TEXT } from './tool-results/shared'
import { ToolResultRenderer } from './tool-results'
import { Foldable } from './tool-results/primitives'
import { useChatStore } from '@/stores/chat'
import { ApiError } from '@/lib/agent-api'
import { formatTokens } from '@/lib/format'
import type { ChatAgentApi, RewindResult } from '@/hooks/useChatAgentApi'
import type { AgentStatus, Attachment, ChatMessage, ContentBlock } from '@/lib/agent-types'
import {
  extractTag,
  extractTagContent,
  parseXmlAttrs,
  hasTaskNotification,
  parseTaskNotification,
  hasCommandMessage,
  hasBashInput,
  hasBashOutput,
  hasLocalCommandCaveat,
  hasLocalCommandStdout,
  LOCAL_COMMAND_STDOUT,
  hasSystemReminder,
  getStatusColor,
  stripKnownXmlTags,
  stripAnsi,
  hasUserMemoryInput,
  hasTeammateMessage,
  hasChannelMessage,
  hasMcpResourceUpdate,
  hasCrossSessionMessage,
  hasForkBoilerplate,
  hasGithubWebhook,
  hasIdeContext
} from '@/lib/xml-tags'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  DialogClose
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/sonner'

interface ChatMessageListProps {
  agent: ChatAgentApi
}

/** 距底部小于该值视为“在底部”，继续自动追随 */
const SCROLL_BOTTOM_THRESHOLD = 60

/**
 * 跨 message 全局去重 TaskUpdate：同一 task 只保留最后一次调用（最终状态），
 * 丢弃历史 in_progress 中间态。TaskUpdate 是 per-call 渲染（每次调用独立卡片），
 * 中间态卡片不会因后续 completed 调用而更新，会永远显示「进行中」+ 永转 spinner。
 * 对齐 claude-code 的 todos state 渲染语义（显示任务当前状态，非调用历史）。
 */
function dedupeTaskUpdates(messages: ChatMessage[]): ChatMessage[] {
  type Pos = { mi: number; bi: number }
  const lastByTask = new Map<string, Pos>()
  messages.forEach((m, mi) => {
    if (m.type !== 'assistant') return
    m.content.forEach((b, bi) => {
      if (b.type === 'tool_use' && b.name === 'TaskUpdate') {
        const tid = String(b.input.taskId ?? b.input.id ?? b.input.task_id ?? '')
        if (tid) lastByTask.set(tid, { mi, bi })
      }
    })
  })
  if (lastByTask.size === 0) return messages
  return messages.map((m, mi) => {
    if (m.type !== 'assistant') return m
    let changed = false
    const content = m.content.filter((b, bi) => {
      if (b.type === 'tool_use' && b.name === 'TaskUpdate') {
        const tid = String(b.input.taskId ?? b.input.id ?? b.input.task_id ?? '')
        if (tid) {
          const last = lastByTask.get(tid)
          if (last && !(last.mi === mi && last.bi === bi)) {
            changed = true
            return false
          }
        }
      }
      return true
    })
    return changed ? { ...m, content } : m
  })
}

export function ChatMessageList({ agent }: ChatMessageListProps): React.JSX.Element {
  const listRef = useRef<HTMLDivElement>(null)
  /** 内容容器（消息列表根），ResizeObserver 监听它的高度变化以同步追随 */
  const contentRef = useRef<HTMLDivElement>(null)
  /** 是否粘底追随。比 state 更新的即时副本，供 ResizeObserver 回调同步读取 */
  const stickRef = useRef(true)
  const prevSessionId = useRef<string | null>(agent.sessionId)
  const [atBottom, setAtBottom] = useState(true)

  const {
    messages,
    isRunning,
    isCompacting,
    isSwitchingSession,
    status,
    activeToolCall,
    lastError,
    approvalRequests,
    commands,
    personaId,
    personaLabel,
    personas,
    personasLoading,
    selectPersona,
    loadPersonas,
    sendMessage,
    interruptRun,
    approve,
    rewindFiles
  } = agent
  /** 全局去重 TaskUpdate 中间态：每 task 只显示最终状态 */
  const visibleMessages = useMemo(() => dedupeTaskUpdates(messages), [messages])
  const hasMessages = messages.length > 0

  // 同步滚动到底（直接赋值 scrollTop，绕过 CSS scroll-behavior，避免流式抖动）
  const scrollToBottom = useCallback((): void => {
    const el = listRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [])

  // 用户滚动 → 更新粘底状态（同时驱动“回到底部”按钮显隐）
  const handleScroll = useCallback((): void => {
    const el = listRef.current
    if (!el) return
    const next = el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_BOTTOM_THRESHOLD
    stickRef.current = next
    setAtBottom((prev) => (prev === next ? prev : next))
  }, [])

  // 切换会话 → 强制粘底
  useEffect(() => {
    if (agent.sessionId === prevSessionId.current) return
    prevSessionId.current = agent.sessionId
    stickRef.current = true
    setAtBottom(true)
    // messages 由 resumeSession 异步加载，DOM 就绪后 rAF 兜底滚两次
    // （覆盖 markdown/代码块等异步撑高的二次布局）
    requestAnimationFrame(() => {
      scrollToBottom()
      requestAnimationFrame(scrollToBottom)
    })
  }, [agent.sessionId, scrollToBottom])

  // ResizeObserver：粘底时内容高度增长 → layout 后 paint 前同步追随。
  // 复刻 opencode create-auto-scroll 的核心思路：用 ResizeObserver 而非 scrollIntoView，
  // 在同一帧内把 scrollTop 推到底，避免“先长高再追上来”的可见抖动。
  useEffect(() => {
    if (!hasMessages) return
    const scrollEl = listRef.current
    const contentEl = contentRef.current
    if (!scrollEl || !contentEl) return
    const ro = new ResizeObserver(() => {
      if (stickRef.current) scrollEl.scrollTop = scrollEl.scrollHeight
    })
    ro.observe(contentEl)
    return () => ro.disconnect()
  }, [hasMessages])

  // 主动发送消息 → 强制粘底（用户发送即期望看到回复）
  const handleSend = useCallback(
    (text: string, attachments?: Attachment[]): void => {
      stickRef.current = true
      setAtBottom(true)
      sendMessage(text, attachments)
    },
    [sendMessage]
  )

  // persona 选中回调：热切换失败（409 忙碌等）toast 提示（纯选择分支不会失败）
  const handleSelectPersona = useCallback(
    (id: string | undefined): void => {
      void selectPersona(id).catch((err: unknown) => {
        toast.error(err instanceof ApiError ? err.message : '切换智能体失败')
      })
    },
    [selectPersona]
  )

  // 点击“回到底部”
  const resumeScroll = useCallback((): void => {
    stickRef.current = true
    setAtBottom(true)
    scrollToBottom()
  }, [scrollToBottom])

  return (
    <div className="h-full min-h-0 flex flex-col bg-[var(--bg-base)]">
      <div className="flex-1 min-h-0 relative">
        <div
          ref={listRef}
          onScroll={handleScroll}
          style={{ overflowAnchor: 'none' }}
          className="h-full overflow-y-auto overflow-x-hidden"
        >
          <div
            className={`transition-opacity duration-200 ${isSwitchingSession ? 'opacity-0' : 'opacity-100'}`}
          >
            {hasMessages ? (
              <div ref={contentRef} className="flex flex-col">
                {visibleMessages.map((message, i) => (
                  <MessageItem
                    key={message.id}
                    message={message}
                    isThinkingActive={
                      status === 'thinking' &&
                      i === visibleMessages.length - 1 &&
                      message.type === 'assistant'
                    }
                    isStreaming={
                      (status === 'thinking' || status === 'responding') &&
                      i === visibleMessages.length - 1 &&
                      message.type === 'assistant'
                    }
                    onRewind={rewindFiles}
                    isRunning={isRunning}
                  />
                ))}
              </div>
            ) : (
              <EmptyState />
            )}
          </div>
        </div>
        {/* loading 覆盖层：absolute 不随滚动，opacity crossfade 淡入淡出 */}
        <div
          className={`absolute inset-0 flex flex-col items-center justify-center gap-2 text-[var(--text-faint)] transition-opacity duration-200 ${
            isSwitchingSession ? 'opacity-100' : 'opacity-0 pointer-events-none'
          }`}
        >
          <Loader className="size-5 animate-spin" />
          <span className="text-[12px]">加载会话…</span>
        </div>
        {hasMessages && !isSwitchingSession && (
          <button
            onClick={resumeScroll}
            className={[
              'absolute bottom-3 right-4 size-9 flex items-center justify-center rounded-full z-10',
              'bg-[var(--bg-base)] border border-[var(--border-base)] shadow-[var(--elevation-raised)]',
              'text-[var(--text-muted)] hover:text-[var(--text-base)] hover:bg-[var(--overlay-hover)]',
              'transition-all duration-200',
              atBottom ? 'opacity-0 pointer-events-none translate-y-2 scale-95' : 'opacity-100'
            ].join(' ')}
            title="回到底部"
          >
            <ArrowDownIcon className="size-4" />
          </button>
        )}
      </div>

      {approvalRequests.length > 0 && (
        <div className="shrink-0 max-h-[60vh] overflow-auto">
          {approvalRequests.map((r) => (
            <PermissionRequest
              key={r.toolCallId}
              request={r}
              onApprove={(allowed, mi, fb, aa) => approve(r.toolCallId, allowed, mi, fb, aa)}
            />
          ))}
        </div>
      )}

      <StatusBar
        status={status}
        isCompacting={isCompacting}
        activeToolCall={activeToolCall}
        lastError={lastError}
        contextPct={agent.contextUsage?.percentage}
      />

      <ChatInput
        isRunning={isRunning}
        isSwitchingSession={isSwitchingSession}
        commands={commands}
        projectId={agent.projectId}
        personaId={personaId}
        personaLabel={personaLabel}
        personas={personas}
        personasLoading={personasLoading}
        personaBusy={isRunning || isSwitchingSession}
        onOpenPersonas={loadPersonas}
        onSelectPersona={handleSelectPersona}
        onSend={handleSend}
        onInterrupt={interruptRun}
      />
    </div>
  )
}

function EmptyState(): React.JSX.Element {
  return <UsageGuide />
}

// memo：流式时 store 只对正在输出的那条消息创建新引用，历史消息引用稳定，
// 默认浅比较即可让历史消息（含 react-markdown 解析）跳过重渲染。
const MessageItem = memo(function MessageItem({
  message,
  isThinkingActive,
  isStreaming,
  onRewind,
  isRunning
}: {
  message: ChatMessage
  isThinkingActive?: boolean
  isStreaming?: boolean
  onRewind: (checkpointId: string, dryRun?: boolean) => Promise<RewindResult | null>
  isRunning: boolean
}): React.JSX.Element {
  switch (message.type) {
    case 'user':
      return <UserBubble message={message} onRewind={onRewind} isRunning={isRunning} />
    case 'assistant':
      return (
        <AssistantBubble
          message={message}
          isThinkingActive={isThinkingActive}
          isStreaming={isStreaming}
        />
      )
    case 'system':
      return <SystemBubble message={message} />
    case 'compaction':
      return <CompactionDivider message={message} />
  }
})

// ===== 用户消息（XML 标签感知）=====

/**
 * A 类 stub 标签的最小渲染（memory/teammate/channel/mcp-resource/cross-session）。
 * 当前项目多数触发不了（无 swarm/MCP channel/IDE bridge），代码就绪，能力启用即生效。
 * ide_opened_file/ide_selection/fork-boilerplate/github-webhook 对齐 claude-code 隐藏。
 * 返回 null 表示非 stub，交回主链处理。
 */
function renderStubUserTag(content: string): React.JSX.Element | null {
  if (hasIdeContext(content) || hasForkBoilerplate(content) || hasGithubWebhook(content)) {
    return <></>
  }
  if (hasUserMemoryInput(content)) {
    const text = extractTag(content, 'user-memory-input') ?? ''
    return (
      <div className="flex flex-col gap-0.5 px-4 py-0.5">
        <span className="text-[11px] font-mono select-none">
          <span className="text-pink-400"># </span>
          <span className="text-[var(--text-muted)]">{text.slice(0, 200)}</span>
        </span>
        <span className="text-[11px] text-[var(--text-faint)] select-none">已记住</span>
      </div>
    )
  }
  if (hasTeammateMessage(content)) {
    const attrs = parseXmlAttrs('teammate-message', content)
    const body = extractTagContent('teammate-message', content) ?? ''
    return (
      <div className="flex px-4 py-0.5">
        <span className="text-[11px] text-[var(--text-faint)] select-none">
          <span className="text-purple-400">@{attrs.teammate_id ?? 'teammate'}</span>
          {attrs.summary ? ` ${attrs.summary}` : body ? ` ${body.slice(0, 100)}` : ''}
        </span>
      </div>
    )
  }
  if (hasChannelMessage(content)) {
    const attrs = parseXmlAttrs('channel', content)
    const body = extractTagContent('channel', content) ?? ''
    return (
      <div className="flex px-4 py-0.5">
        <span className="text-[11px] text-[var(--text-faint)] select-none">
          ↞ <span className="text-purple-400">{attrs.source ?? 'channel'}</span>
          {attrs.user ? ` · ${attrs.user}` : ''}
          {`: ${body.slice(0, 60)}`}
        </span>
      </div>
    )
  }
  if (hasMcpResourceUpdate(content)) {
    const tag = content.includes('<mcp-resource-update')
      ? 'mcp-resource-update'
      : 'mcp-polling-update'
    const attrs = parseXmlAttrs(tag, content)
    const reason = extractTag(content, 'reason')
    const target = attrs.uri ?? attrs.tool ?? ''
    return (
      <div className="flex px-4 py-0.5">
        <span className="text-[11px] text-[var(--text-faint)] select-none">
          ↻ <span className="text-emerald-400">{attrs.server ?? 'mcp'}</span>
          {target ? `: ${target}` : ''}
          {reason ? ` · ${reason}` : ''}
        </span>
      </div>
    )
  }
  if (hasCrossSessionMessage(content)) {
    const attrs = parseXmlAttrs('cross-session-message', content)
    const body = extractTagContent('cross-session-message', content) ?? ''
    return (
      <div className="flex px-4 py-0.5">
        <span className="text-[11px] text-[var(--text-faint)] select-none">
          ← {attrs.from ? `${attrs.from}: ` : ''}
          {body.slice(0, 100)}
        </span>
      </div>
    )
  }
  return null
}

// web 版无 dryRun 预览（后端 rewind 不支持）：弹窗为静态警示，确认即执行
const UserBubble = memo(function UserBubble({
  message,
  onRewind,
  isRunning
}: {
  message: { id: string; content: string }
  onRewind: (checkpointId: string) => Promise<RewindResult | null>
  isRunning: boolean
}): React.JSX.Element {
  const content = message.content
  const [dialogOpen, setDialogOpen] = useState(false)
  const [executing, setExecuting] = useState(false)

  const handleConfirm = async (): Promise<void> => {
    setExecuting(true)
    const r = await onRewind(message.id)
    setExecuting(false)
    setDialogOpen(false)
    if (!r) {
      toast.error('回滚失败', { description: '会话未激活' })
      return
    }
    if (r.success) {
      toast.success('文件已回滚', { description: '消息之后的文件改动已撤销' })
    } else {
      toast.error('回滚失败', { description: r.message ?? '未知错误' })
    }
  }

  // 按优先级检测 XML 标签，复刻 Claude Code UserTextMessage 模式

  // 1. 隐藏类标签
  if (hasLocalCommandCaveat(content)) return <></>

  // 2. task-notification → 状态摘要 + (增强) result/usage/worktree
  if (hasTaskNotification(content)) {
    const tn = parseTaskNotification(content)
    if (tn.summary || tn.result || tn.usage) {
      return (
        <div className="flex flex-col gap-0.5 px-4 py-0.5">
          {tn.summary && (
            <span className={`text-[11px] select-none ${getStatusColor(tn.status)}`}>
              {tn.summary}
            </span>
          )}
          {tn.usage && (
            <span className="text-[11px] text-[var(--text-faint)] tabular-nums select-none">
              {tn.usage.total_tokens !== null ? formatTokens(tn.usage.total_tokens) : ''}
              {tn.usage.tool_uses !== null ? ` · ${tn.usage.tool_uses} 工具` : ''}
              {tn.usage.duration_ms !== null
                ? ` · ${(tn.usage.duration_ms / 1000).toFixed(1)}s`
                : ''}
            </span>
          )}
          {tn.result && <Foldable content={tn.result} />}
          {tn.worktreePath && (
            <span className="text-[11px] text-[var(--text-faint)] select-none">
              ⏶ {tn.worktreePath}
              {tn.worktreeBranch ? ` (${tn.worktreeBranch})` : ''}
            </span>
          )}
        </div>
      )
    }
  }

  // 3. command-message → > /name args
  if (hasCommandMessage(content)) {
    const name = extractTag(content, 'command-message')
    const args = extractTag(content, 'command-args')
    const parts = [name, args].filter(Boolean)
    return (
      <div className="flex px-4 py-0.5">
        <span className="text-[11px] text-[var(--text-faint)] font-mono select-none">
          {'> /'}
          {parts.join(' ')}
        </span>
      </div>
    )
  }

  // 4. bash-input → ! command
  if (hasBashInput(content)) {
    const cmd = extractTag(content, 'bash-input')
    return (
      <div className="flex px-4 py-0.5">
        <span className="text-[11px] text-[var(--text-faint)] font-mono select-none">
          <span className="text-pink-400">! </span>
          {cmd ?? content.slice(0, 200)}
        </span>
      </div>
    )
  }

  // 5. bash-stdout/stderr → 折叠展示
  if (hasBashOutput(content)) {
    const stdout = extractTag(content, 'bash-stdout')
    const stderr = extractTag(content, 'bash-stderr')
    const text = stdout ?? stderr ?? content
    return (
      <div className="px-4 py-0.5">
        <details className="text-[11px]">
          <summary className="cursor-pointer text-[var(--text-faint)] hover:text-[var(--text-muted)] inline-flex items-center gap-1 select-none">
            {stdout ? '输出' : '错误输出'} · {text.length} 字符
          </summary>
          <pre className="mt-1 text-[11px] text-[var(--text-faint)] whitespace-pre-wrap font-mono bg-[var(--bg-layer-01)] p-2 rounded max-h-[160px] overflow-auto border border-[var(--border-muted)]">
            {text.slice(0, 2000)}
          </pre>
        </details>
      </div>
    )
  }

  // 6. system-reminder → dim 小字居中
  if (hasSystemReminder(content)) {
    const text = extractTag(content, 'system-reminder') ?? stripKnownXmlTags(content)
    if (!text) return <></>
    return (
      <div className="flex justify-center px-4 py-0.5">
        <span className="text-[11px] text-[var(--text-faint)] italic text-center">{text}</span>
      </div>
    )
  }

  // 7. local-command-stdout → slash 命令输出（如 /model），淡色等宽 + 剥离 ANSI
  if (hasLocalCommandStdout(content)) {
    const text = stripAnsi(extractTag(content, LOCAL_COMMAND_STDOUT) ?? '')
    if (!text.trim()) return <></>
    return (
      <div className="px-4 py-0.5">
        <div className="text-[12px] text-[var(--text-faint)] whitespace-pre-wrap break-words font-mono">
          {text}
        </div>
      </div>
    )
  }

  // 7.5 stub 占位标签（memory/teammate/channel/mcp-resource/cross-session；ide/fork/webhook 隐藏）
  const stub = renderStubUserTag(content)
  if (stub !== null) return stub

  // 8. 普通文本 → 剥离已知 XML 标签后展示
  const clean = stripKnownXmlTags(content)
  if (!clean) return <></>

  return (
    <div className="flex justify-end items-start gap-1.5 px-4 py-1">
      <div className="max-w-[80%] rounded-2xl rounded-br-md bg-[var(--grey-1000)] px-3.5 py-2">
        <p className="text-[15px] leading-relaxed whitespace-pre-wrap break-words text-[var(--text-base)]">
          {clean}
        </p>
      </div>
      <button
        onClick={() => setDialogOpen(true)}
        disabled={isRunning || dialogOpen}
        title="回滚文件到此消息前"
        aria-label="回滚文件到此消息前"
        className="mt-1 size-6 flex items-center justify-center rounded text-[var(--text-faint)] hover:text-[var(--text-muted)] hover:bg-[var(--overlay-hover)] disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer transition-colors"
      >
        <Undo2Icon className="size-3.5" />
      </button>

      <Dialog
        open={dialogOpen}
        onOpenChange={(o) => {
          if (!executing) setDialogOpen(o)
        }}
      >
        <DialogContent hideClose={executing}>
          <DialogHeader>
            <DialogTitle>回滚文件</DialogTitle>
            <DialogDescription>将撤销此消息之后的所有文件改动，此操作不可恢复。</DialogDescription>
          </DialogHeader>

          <div className="min-h-[2.5rem] flex items-center">
            <span className="inline-flex items-center gap-2 text-[13px] text-[var(--text-muted)]">
              <Undo2Icon className="size-4 text-amber-400" />
              消息之后的文件改动将被撤销，之前的对话保留
            </span>
          </div>

          <DialogFooter>
            <DialogClose
              render={
                <Button variant="outline" size="sm" disabled={executing}>
                  取消
                </Button>
              }
            />
            <Button variant="destructive" size="sm" disabled={executing} onClick={handleConfirm}>
              {executing ? (
                <Loader2Icon className="size-4 animate-spin" />
              ) : (
                <Undo2Icon className="size-4" />
              )}
              {executing ? '回滚中…' : '确认回滚'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
})

// ===== AI 消息 =====

// memo：assistant 消息最重（含 markdown/代码块/工具结果），历史消息引用稳定，
// 浅比较即可跳过重渲染与 markdown 重解析。
// 不用 content-visibility:auto —— 它在 flex 滚动容器内会让离屏历史消息首帧以
// intrinsic-size 参与高度计算，把列表撑高一截，导致输入框被裁出窗口底部。
const AssistantBubble = memo(function AssistantBubble({
  message,
  isThinkingActive,
  isStreaming
}: {
  message: { id: string; content: ContentBlock[]; partial?: boolean }
  isThinkingActive?: boolean
  isStreaming?: boolean
}): React.JSX.Element {
  return (
    <div className="flex flex-col px-4 py-1.5">
      {message.content.map((block, i) => (
        <ContentBlockView
          key={block.type === 'tool_use' ? block.id : i}
          block={block}
          isThinkingActive={isThinkingActive && i === message.content.length - 1}
          isStreaming={isStreaming && i === message.content.length - 1}
        />
      ))}
      {message.partial && (
        <span className="text-[11px] text-[var(--text-faint)] select-none">（已中断）</span>
      )}
    </div>
  )
})

// memo：content 数组中未变化的 block 引用稳定（流式只重建末尾正在变化的 block）
const ContentBlockView = memo(function ContentBlockView({
  block,
  isThinkingActive,
  isStreaming
}: {
  block: ContentBlock
  isThinkingActive?: boolean
  isStreaming?: boolean
}): React.JSX.Element {
  if (block.type === 'text') {
    return <AssistantContent text={block.text} isStreaming={!!isStreaming} />
  }
  if (block.type === 'thinking') {
    // 空思考内容不渲染
    if (!block.text) return <></>
    return <ThinkingBlock text={block.text} isStreaming={!!isThinkingActive} />
  }
  // Agent / Task 工具 → 子代理渲染
  if (block.name === 'Agent' || block.name === 'Task') {
    return (
      <SubagentBlock
        toolUseId={block.id}
        input={block.input}
        result={block.result}
        resultError={block.resultError}
      />
    )
  }
  // TaskCreate / TaskUpdate / TaskList / TaskGet → Task 工具渲染
  if (
    block.name === 'TaskCreate' ||
    block.name === 'TaskUpdate' ||
    block.name === 'TaskList' ||
    block.name === 'TaskGet'
  ) {
    return (
      <TaskToolBlock
        name={block.name}
        input={block.input}
        result={block.result}
        resultError={block.resultError}
      />
    )
  }
  return (
    <ToolCallBlock
      name={block.name}
      input={block.input}
      result={block.result}
      resultError={block.resultError}
    />
  )
})

// ═══════════════════════════════════════════════════════════════
// Claude Code 对齐布局（纯 HTML/CSS）：
//
//   ● Read(file.ts)       ← ● 在 w-5 gutter，工具名在内容区
//   │ result content…     ← CSS border-l-2 竖线, 精确在工具名正下方
// ═══════════════════════════════════════════════════════════════

/* ─── 底层 Row ─── */

function Row({
  gutter,
  children,
  onClick,
  clickable
}: {
  gutter: React.ReactNode
  children: React.ReactNode
  onClick?: () => void
  clickable?: boolean
}): React.JSX.Element {
  const cursorClass = clickable ? 'cursor-pointer hover:text-[var(--text-muted)]' : ''
  return (
    <div className={`flex flex-row items-start ${cursorClass}`} onClick={onClick}>
      <span className={`${GUTTER} ${GUTTER_TEXT} leading-relaxed`} aria-hidden>
        {gutter}
      </span>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  )
}

/* ─── 文本 ─── */

const AssistantContent = memo(function AssistantContent({
  text,
  isStreaming
}: {
  text: string
  isStreaming?: boolean
}): React.JSX.Element {
  return (
    <Row gutter="">
      <Markdown isStreaming={isStreaming}>{stripKnownXmlTags(text)}</Markdown>
    </Row>
  )
})

/* ─── Thinking ─── */

const ThinkingBlock = memo(function ThinkingBlock({
  text,
  isStreaming
}: {
  text: string
  isStreaming: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const prevStreamingRef = useRef(false)

  // isStreaming 从 false→true 时自动展开；从 true→false 时自动折叠
  useEffect(() => {
    if (prevStreamingRef.current !== isStreaming) {
      prevStreamingRef.current = isStreaming
      setOpen(isStreaming)
    }
  }, [isStreaming])

  // 展开时自动滚动到底部（跟随新内容）
  useEffect(() => {
    if (open && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [open, text])

  return (
    <div className="py-0.5">
      <Row gutter="" onClick={() => setOpen(!open)} clickable>
        <span className="text-[11px] text-[var(--text-faint)] inline-flex items-center gap-1.5">
          <ChevronRightIcon
            className={`size-2.5 transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
          />
          思考过程
        </span>
      </Row>
      {open && (
        <div
          ref={scrollRef}
          className="mt-1 ml-5 bg-[var(--bg-layer-01)] p-2 rounded border border-[var(--border-muted)] max-h-[240px] overflow-auto"
        >
          <Markdown dimColor isStreaming={isStreaming}>
            {text}
          </Markdown>
        </div>
      )}
    </div>
  )
})

/* ─── Subagent 运行指示器 ─── */

/**
 * web 增强：无 result 时订阅 subagentByToolUse 实时进度（lastToolName/description），
 * 后端 subagent_progress 事件驱动；store 订阅在组件内部，不破坏 ContentBlockView memo 分界。
 */
function SubagentBlock({
  toolUseId,
  input,
  result,
  resultError
}: {
  toolUseId: string
  input: Record<string, unknown>
  result?: string
  resultError?: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const isRunning = result === undefined
  const subagent = useChatStore((s) =>
    s.subagentByToolUse[toolUseId] === undefined || result !== undefined
      ? undefined
      : s.subagentByToolUse[toolUseId]
  )
  const agentType =
    (input.subagent_type as string | undefined) ?? (input.name as string | undefined) ?? '子智能体'
  const promptPreview =
    typeof input.prompt === 'string'
      ? input.prompt.slice(0, 80) + (input.prompt.length > 80 ? '…' : '')
      : ''

  const dotColor = resultError ? 'bg-red-400' : isRunning ? 'bg-purple-400' : 'bg-green-400'
  // 实时进度文案：正在 <工具>（subagent_progress 推送）> 任务描述 > 运行中…
  const progressLabel = subagent
    ? subagent.lastToolName
      ? `正在 ${subagent.lastToolName}`
      : (subagent.description ?? '运行中…')
    : '运行中…'

  return (
    <div className="py-0.5">
      {/* 标题行 */}
      <Row gutter="" onClick={() => setOpen(!open)} clickable>
        <span className="text-[11px] text-[var(--text-faint)] inline-flex items-center gap-1.5 select-none">
          {resultError ? (
            <span className="size-3 text-red-400 shrink-0">✕</span>
          ) : isRunning ? (
            <Loader2Icon className="size-3 animate-spin text-purple-400 shrink-0" />
          ) : (
            <CheckIcon className="size-3 text-green-400 shrink-0" />
          )}
          <span
            className={`size-1.5 rounded-full ${dotColor} ${isRunning ? 'animate-pulse' : ''}`}
          />
          <code className="text-[11px] font-mono text-[var(--text-muted)] truncate max-w-[200px]">
            {agentType}
          </code>
          {isRunning && <span className="text-[var(--text-faint)]">{progressLabel}</span>}
          {resultError && <span className="text-red-400">执行出错</span>}
        </span>
      </Row>

      {/* 展开详情 */}
      {open && (
        <div className="mt-1 ml-5 flex flex-col gap-2">
          {promptPreview && (
            <div className="text-[11px] text-[var(--text-faint)] bg-[var(--bg-layer-01)] p-2 rounded border border-[var(--border-muted)]">
              <span className="font-medium text-[var(--text-muted)]">任务: </span>
              {promptPreview}
            </div>
          )}
          {result && (
            <div className="relative">
              <div className="max-h-[160px] overflow-auto text-[11px] text-[var(--text-faint)] bg-[var(--bg-layer-01)] p-2 rounded border border-[var(--border-muted)]">
                <Markdown dimColor>
                  {result.length > 500 ? result.slice(0, 500) + '…' : result}
                </Markdown>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/* ─── Task/Todo 进度卡片 ─── */

function TaskToolBlock({
  name,
  input,
  result,
  resultError
}: {
  name: string
  input: Record<string, unknown>
  result?: string
  resultError?: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)

  if (name === 'TaskCreate') {
    const subject = (input.subject as string) ?? ''
    const description = (input.description as string) ?? ''
    const hasResult = result !== undefined
    const statusLabel = hasResult ? '已创建' : '待处理'
    const statusColor = hasResult ? 'text-green-500' : 'text-[var(--text-faint)]'
    const dotClass = hasResult
      ? 'size-1.5 rounded-full bg-green-500'
      : 'size-1.5 rounded-full border border-[var(--text-faint)]'
    return (
      <div className="py-0.5">
        <Row gutter="" onClick={() => setOpen(!open)} clickable>
          <span className="text-[11px] text-[var(--text-faint)] inline-flex items-center gap-1.5 select-none">
            <ChevronRightIcon
              className={`size-2.5 transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
            />
            <span className="size-3 flex items-center justify-center">
              <span className={dotClass} />
            </span>
            <code className="text-[11px] font-mono text-[var(--text-muted)] truncate max-w-[300px]">
              {subject}
            </code>
            <span className={statusColor}>{statusLabel}</span>
          </span>
        </Row>
        {open && (description || hasResult) && (
          <div className="mt-1 ml-5 flex flex-col gap-1">
            {description && (
              <div className="text-[11px] text-[var(--text-faint)] bg-[var(--bg-layer-01)] p-2 rounded border border-[var(--border-muted)]">
                {description}
              </div>
            )}
            {hasResult && result && (
              <div className="text-[11px] text-[var(--text-faint)] bg-[var(--bg-layer-01)] p-2 rounded border border-[var(--border-muted)] max-h-[100px] overflow-auto">
                <Markdown dimColor>
                  {result.length > 300 ? result.slice(0, 300) + '…' : result}
                </Markdown>
              </div>
            )}
          </div>
        )}
      </div>
    )
  }

  if (name === 'TaskUpdate') {
    // SDK 流式传输中键名可能不规范，兼容 taskId/id/task_id
    const taskId =
      (input.taskId as string | undefined) ??
      (input.id as string | undefined) ??
      (input.task_id as string | undefined) ??
      ''
    const status = (input.status as string) ?? ''
    const subject = (input.subject as string) ?? ''
    const activeForm =
      (input.activeForm as string | undefined) ?? (input.active_form as string | undefined)
    const label = activeForm && status === 'in_progress' ? activeForm : subject || `任务 ${taskId}`
    let icon: React.ReactNode
    let statusLabel: string
    let color: string

    // 工具调用出错时优先显示错误
    if (resultError) {
      icon = <span className="size-2.5 text-red-400">✕</span>
      statusLabel = '执行出错'
      color = 'text-red-400'
    } else if (status === 'in_progress') {
      icon = <Loader2Icon className="size-2.5 animate-spin text-purple-400" />
      statusLabel = '进行中'
      color = 'text-purple-400'
    } else if (status === 'completed') {
      icon = <CheckIcon className="size-2.5 text-green-500" />
      statusLabel = '已完成'
      color = 'text-green-500'
    } else if (status === 'deleted') {
      icon = <span className="size-2.5 text-red-400">✕</span>
      statusLabel = '已删除'
      color = 'text-red-400'
    } else {
      icon = <span className="size-2.5 border border-[var(--text-faint)] rounded-full" />
      statusLabel = status || ''
      color = 'text-[var(--text-faint)]'
    }

    return (
      <div className="py-0.5">
        <Row gutter="">
          <span className={`text-[11px] inline-flex items-center gap-1.5 ${color}`}>
            {icon}
            <code className="font-mono truncate max-w-[300px]">{label}</code>
            {statusLabel && <span className="text-[var(--text-faint)]">{statusLabel}</span>}
          </span>
        </Row>
      </div>
    )
  }

  // TaskList / TaskGet: fallback to default rendering
  return <ToolCallBlock name={name} input={input} result={result} resultError={resultError} />
}

/* ─── Tool call + result ─── */

const TOOL_DISPLAY: Record<string, string> = {
  Read: 'Read',
  Write: 'Write',
  Edit: 'Edit',
  Bash: 'Bash',
  PowerShell: 'PowerShell',
  Grep: 'Grep',
  Glob: 'Glob',
  WebSearch: 'WebSearch',
  WebFetch: 'WebFetch',
  Task: 'Task',
  AskUserQuestion: 'AskUserQuestion',
  NotebookEdit: 'NotebookEdit',
  ExitPlanMode: 'ExitPlanMode'
}

function getDisplayName(name: string, input: Record<string, unknown>): string {
  const base = TOOL_DISPLAY[name] ?? name
  // 常用工具提取关键参数做摘要
  const filePath = (input.file_path ?? input.path) as string | undefined
  if (filePath) {
    const short = typeof filePath === 'string' ? filePath.split(/[/\\]/).slice(-2).join('/') : ''
    return `${base}(${short})`
  }
  if (name === 'Bash' || name === 'PowerShell') {
    const cmd = input.command as string | undefined
    if (cmd) {
      const short = cmd.length > 60 ? cmd.slice(0, 60) + '…' : cmd
      return `${base}(${short.split('\n')[0]})`
    }
  }
  if (name === 'Grep' || name === 'Glob') {
    const pattern = input.pattern as string | undefined
    if (pattern) return `${base}(${pattern})`
  }
  if (name === 'WebSearch' || name === 'WebFetch') {
    const query = (input.query ?? input.url) as string | undefined
    if (query) return `${base}(${typeof query === 'string' ? query.slice(0, 60) : ''})`
  }
  return base
}

const ToolCallBlock = memo(function ToolCallBlock({
  name,
  input,
  result,
  resultError
}: {
  name: string
  input: Record<string, unknown>
  result?: string
  resultError?: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const displayName = getDisplayName(name, input)

  return (
    <div className="py-0.5">
      <Row gutter="" onClick={() => setOpen(!open)} clickable>
        <span className="text-[11px] text-[var(--text-faint)] inline-flex items-center gap-1.5 select-none min-w-0 overflow-hidden whitespace-nowrap">
          <ChevronRightIcon
            className={`size-2.5 transition-transform duration-150 shrink-0 ${open ? 'rotate-90' : ''}`}
          />
          <code className="text-[11px] font-mono text-[var(--text-muted)] truncate min-w-0">
            {displayName}
          </code>
        </span>
      </Row>

      {open && (
        <pre className="mt-1 ml-5 text-[11px] text-[var(--text-faint)] whitespace-pre-wrap font-mono bg-[var(--bg-layer-01)] p-2 rounded max-h-[120px] overflow-auto border border-[var(--border-muted)]">
          {JSON.stringify(input, null, 2)}
        </pre>
      )}

      {result !== undefined && (
        <ToolResultRenderer name={name} input={input} content={result} error={resultError} />
      )}
    </div>
  )
})

// ── 兼容历史 tool_result 消息（web ChatMessage 联合暂无该类型，预留渲染器复用）──

// ===== System 消息 =====

const SystemBubble = memo(function SystemBubble({
  message
}: {
  message: { content: string; level?: string }
}): React.JSX.Element {
  if (!message.content) return <></>
  const color =
    message.level === 'error' || message.level === 'interrupt'
      ? 'text-[var(--text-muted)]'
      : 'text-[var(--text-faint)]'
  return (
    <div className="flex justify-center px-4 py-1">
      <span className={`text-[11px] ${color} text-center italic`}>{message.content}</span>
    </div>
  )
})

// ===== 上下文压缩边界分隔符 =====
// SDK 完成一次 compaction 后插入：标记此处之上的早期消息已被摘要替换。
// preTokens 为压缩前 token；压缩后用量由 context_usage 事件刷新 CostCircle 即时回落。

const CompactionDivider = memo(function CompactionDivider({
  message
}: {
  message: { trigger: 'manual' | 'auto'; preTokens: number }
}): React.JSX.Element {
  const label = message.trigger === 'manual' ? '手动压缩' : '自动压缩'
  return (
    <div className="flex items-center gap-2 px-4 py-2 select-none">
      <span className="flex-1 h-px bg-[var(--border-muted)]" />
      <span className="inline-flex items-center gap-1.5 text-[11px] text-[var(--text-faint)] shrink-0">
        <ArchiveIcon className="size-3" />
        {label}
        {message.preTokens > 0 && (
          <span className="tabular-nums">· 压缩前 {formatTokens(message.preTokens)}</span>
        )}
      </span>
      <span className="flex-1 h-px bg-[var(--border-muted)]" />
    </div>
  )
})

// ===== 状态栏 =====

function StatusBar({
  status,
  isCompacting,
  activeToolCall,
  lastError,
  contextPct
}: {
  status: AgentStatus | 'idle'
  isCompacting: boolean
  activeToolCall: { id: string; name: string; interruptible: boolean } | null
  lastError: string | null
  /** 压缩进行中显示触发时的上下文占用百分比（最近一次 context_usage） */
  contextPct?: number
}): React.JSX.Element | null {
  // 压缩进行中：优先显示压缩态（正交于 AgentStatus，压缩时模型不产生 turn 状态）
  if (isCompacting) {
    return (
      <div className="shrink-0 px-4 py-1 flex items-center gap-1.5 text-[11px] text-[var(--text-faint)]">
        <Loader2Icon className="size-3 animate-spin text-amber-400" />
        <span>正在压缩上下文…{typeof contextPct === 'number' ? `（${contextPct}%）` : ''}</span>
      </div>
    )
  }

  if (status === 'idle') return null

  let dotColor = 'bg-[var(--text-muted)]'
  let label = ''
  switch (status) {
    case 'thinking':
      dotColor = 'bg-purple-400'
      label = '思考中…'
      break
    case 'responding':
      dotColor = 'bg-blue-400'
      label = '回复中…'
      break
    case 'tool-use':
      dotColor = 'bg-amber-400'
      label = activeToolCall ? `调用工具：${activeToolCall.name}` : '执行工具…'
      break
    case 'awaiting-approval':
      dotColor = 'bg-yellow-500'
      label = '等待工具审批…'
      break
    case 'error':
      dotColor = 'bg-red-400'
      label = lastError ? `错误：${lastError}` : '出错了'
      break
  }

  return (
    <div className="shrink-0 px-4 py-1 flex items-center gap-1.5 text-[11px] text-[var(--text-faint)]">
      <span
        className={`size-1.5 rounded-full ${dotColor} ${status !== 'awaiting-approval' ? 'animate-pulse' : ''}`}
      />
      <span>{label}</span>
    </div>
  )
}
