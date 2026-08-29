import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { ArrowDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Separator } from '@/components/ui/separator'

/**
 * 聊天原语 —— 遵循 shadcn chat.md 组合契约：对话用 MessageScroller，行用 Message，
 * 气泡用 Bubble，分隔/系统注记用 Marker（不手搓 bubble div 或裸滚动容器）。
 * 基于项目既有 @base-ui/react + cva 约定手写聚焦实现（官方原语依赖 @shadcn/react，
 * 与本仓 base-ui 体系不兼容）。
 *
 * MessageScroller 内置：流式跟随到底部 + 滚离时显示「回到底部」按钮。
 */

// ===== MessageScroller =====

interface MessageScrollerProps {
  children: React.ReactNode
  /** 初始与流式期间是否自动跟随到底部（默认 true） */
  autoScroll?: boolean
}

export function MessageScroller({
  children,
  autoScroll = true
}: MessageScrollerProps): React.JSX.Element {
  const viewportRef = React.useRef<HTMLDivElement>(null)
  const [atBottom, setAtBottom] = React.useState(autoScroll)

  // 流式追加时若用户在底部则跟随；每次渲染后判定（无 deps 故每帧生效）
  React.useLayoutEffect(() => {
    const el = viewportRef.current
    if (el && atBottom) el.scrollTop = el.scrollHeight
  })

  const handleScroll = (): void => {
    const el = viewportRef.current
    if (!el) return
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight
    setAtBottom(dist < 48)
  }

  const jumpToBottom = (): void => {
    const el = viewportRef.current
    if (el) el.scrollTop = el.scrollHeight
  }

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={viewportRef} onScroll={handleScroll} className="h-full overflow-y-auto">
        <div className="flex flex-col gap-4 p-4">{children}</div>
      </div>
      {!atBottom && (
        <button
          type="button"
          onClick={jumpToBottom}
          aria-label="回到底部"
          className="absolute bottom-4 right-4 flex size-8 items-center justify-center rounded-full border bg-background text-foreground shadow-md hover:bg-accent"
        >
          <ArrowDown className="size-4" />
        </button>
      )}
    </div>
  )
}

/** 行包装（M2 无需 per-item anchor，透传；保留 API 名以兼容未来精细化） */
export function MessageScrollerItem({
  children
}: {
  messageId?: string
  scrollAnchor?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return <>{children}</>
}

// ===== Message =====

export function Message({
  align = 'start',
  children
}: {
  align?: 'start' | 'end'
  children: React.ReactNode
}): React.JSX.Element {
  return <div className={cn('flex flex-col gap-1', align === 'end' && 'items-end')}>{children}</div>
}

export function MessageContent({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="flex flex-col gap-1">{children}</div>
}

// ===== Bubble =====

const bubbleVariants = cva('w-fit max-w-[85%] rounded-lg px-3 py-2 text-sm leading-relaxed', {
  variants: {
    variant: {
      default: 'bg-primary text-primary-foreground',
      secondary: 'bg-secondary text-secondary-foreground',
      muted: 'bg-muted text-muted-foreground',
      outline: 'border bg-background text-foreground',
      ghost: 'text-foreground',
      destructive: 'border-destructive bg-destructive/10 text-destructive'
    }
  },
  defaultVariants: { variant: 'default' }
})

export function Bubble({
  variant = 'default',
  className,
  children
}: VariantProps<typeof bubbleVariants> & {
  className?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className={cn(bubbleVariants({ variant }), className)}>
      <BubbleContent>{children}</BubbleContent>
    </div>
  )
}

export function BubbleContent({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="flex flex-col gap-2">{children}</div>
}

// ===== Marker（系统注记 / 压缩分隔符）=====

export function Marker({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-center gap-3 py-2 text-xs text-muted-foreground">
      <Separator className="flex-1" />
      <span>{children}</span>
      <Separator className="flex-1" />
    </div>
  )
}
