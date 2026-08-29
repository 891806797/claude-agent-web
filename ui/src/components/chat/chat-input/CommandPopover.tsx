import { useEffect, useRef } from 'react'
import type { SlashCommand } from '@/lib/agent-types'

interface CommandPopoverProps {
  open: boolean
  /** 已过滤排序的命令列表（含 alias 项，由父组件计算） */
  commands: SlashCommand[]
  activeIndex: number
  onSelect: (cmd: SlashCommand) => void
  onHover: (index: number) => void
  /** menu 模式（按钮触发）：顶部渲染搜索框，query 来自搜索框 */
  searchMode?: boolean
  searchQuery?: string
  onSearchQueryChange?: (q: string) => void
  onSearchKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void
}

export function CommandPopover({
  open,
  commands,
  activeIndex,
  onSelect,
  onHover,
  searchMode = false,
  searchQuery,
  onSearchQueryChange,
  onSearchKeyDown
}: CommandPopoverProps): React.JSX.Element | null {
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const searchRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    itemRefs.current[activeIndex]?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, open])

  // menu 模式打开时聚焦搜索框
  useEffect(() => {
    if (open && searchMode) requestAnimationFrame(() => searchRef.current?.focus())
  }, [open, searchMode])

  if (!open) return null
  return (
    <div className="absolute bottom-full left-2 right-2 mb-2 max-h-64 overflow-hidden rounded-xl border border-[var(--border-base)] bg-[var(--bg-base)] shadow-[var(--elevation-raised)] z-40 py-1 flex flex-col">
      {searchMode && (
        <div className="px-2 pb-1 shrink-0">
          <input
            ref={searchRef}
            value={searchQuery}
            onChange={(e) => onSearchQueryChange?.(e.target.value)}
            onKeyDown={onSearchKeyDown}
            placeholder="搜索命令…"
            spellCheck={false}
            className="h-7 w-full rounded-md border border-[var(--border-base)] bg-[var(--bg-layer-01)] px-2 text-[13px] text-[var(--text-base)] outline-none focus:border-[var(--grey-400)]"
          />
        </div>
      )}
      <div className="overflow-auto">
        {commands.length === 0 && (
          <div className="px-3 py-3 text-[13px] text-[var(--text-faint)]">无匹配命令</div>
        )}
        {commands.map((cmd, i) => (
          <button
            key={`${cmd.name}-${i}`}
            ref={(el) => {
              itemRefs.current[i] = el
            }}
            onMouseDown={(e) => {
              e.preventDefault()
              onSelect(cmd)
            }}
            onMouseEnter={() => onHover(i)}
            className={[
              'w-full flex items-center gap-2 px-3 py-1.5 text-left transition-colors',
              i === activeIndex ? 'bg-[var(--overlay-hover)]' : ''
            ].join(' ')}
          >
            <code className="text-[13px] font-mono text-[var(--text-base)] shrink-0">
              /{cmd.name}
            </code>
            {cmd.argumentHint && (
              <span className="text-[11px] text-[var(--text-faint)] shrink-0">
                {cmd.argumentHint}
              </span>
            )}
            <span className="text-[12px] text-[var(--text-faint)] truncate flex-1 text-right">
              {cmd.description}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}
