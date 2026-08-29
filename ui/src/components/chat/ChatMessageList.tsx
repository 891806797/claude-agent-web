import { ChevronRight } from 'lucide-react'
import { useState } from 'react'
import { Markdown } from '@/components/chat/Markdown'
import { ToolCallBlock } from '@/components/chat/ToolCallBlock'
import { Marker, MessageScroller, MessageScrollerItem } from '@/components/ui/chat'
import { Bubble, Message } from '@/components/ui/chat'
import { cn } from '@/lib/utils'
import type { ChatMessage, ContentBlock } from '@/lib/agent-types'

/**
 * 消息渲染 —— 对齐 desktop 视觉：
 * - 用户：右侧软气泡（bg-secondary，圆角 2xl，不刺眼）
 * - assistant：全宽无气泡，text 走 Markdown，tool_use 走 gutter 竖线
 * - system/compaction：居中 Marker 分隔符
 * 流式累积与历史回放共用。
 */
export function ChatMessageList({ messages }: { messages: ChatMessage[] }): React.JSX.Element {
  return (
    <MessageScroller>
      {messages.map((m) => (
        <MessageScrollerItem key={m.id} messageId={m.id}>
          <MessageItem message={m} />
        </MessageScrollerItem>
      ))}
    </MessageScroller>
  )
}

export function MessageItem({ message }: { message: ChatMessage }): React.JSX.Element {
  switch (message.type) {
    case 'user':
      return (
        <Message align="end">
          <Bubble variant="secondary" className="max-w-[85%] rounded-2xl px-3.5 py-2">
            <div className="whitespace-pre-wrap break-words text-sm">{message.content}</div>
          </Bubble>
        </Message>
      )
    case 'assistant':
      return (
        <div className="flex flex-col gap-1.5 px-1 py-1">
          {message.content.map((b, i) => (
            <BlockView key={b.type === 'tool_use' ? b.id : i} block={b} />
          ))}
          {message.partial && <span className="text-xs text-muted-foreground">（已中断）</span>}
        </div>
      )
    case 'system':
      if (message.level === 'error') {
        return (
          <Message>
            <Bubble variant="destructive" className="rounded-lg">
              {message.content}
            </Bubble>
          </Message>
        )
      }
      return <Marker>{message.content}</Marker>
    case 'compaction':
      return <Marker>上下文已压缩 · {message.trigger === 'manual' ? '手动' : '自动'}</Marker>
  }
}

function BlockView({ block }: { block: ContentBlock }): React.JSX.Element {
  if (block.type === 'text') {
    return <Markdown>{block.text}</Markdown>
  }
  if (block.type === 'thinking') {
    return <ThinkingBlock text={block.text} />
  }
  return <ToolCallBlock block={block} />
}

function ThinkingBlock({ text }: { text: string }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className="text-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 text-muted-foreground hover:text-foreground"
      >
        <ChevronRight className={cn('size-3 transition-transform', open && 'rotate-90')} />
        思考过程
      </button>
      {open && (
        <div className="mt-1 border-l-2 border-border pl-2 text-muted-foreground">
          <Markdown>{text}</Markdown>
        </div>
      )}
    </div>
  )
}
