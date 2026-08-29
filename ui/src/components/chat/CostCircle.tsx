import { useCompactRequestStore } from '@/stores/compact-request'
import { useCallback, useMemo, useRef, useState } from 'react'
import { formatTokens } from '@/lib/format'
import type { ChatAgentApi } from '@/hooks/useChatAgentApi'

function formatCost(usd: number): string {
  if (usd === 0) return '$0.00'
  if (usd < 0.01) return '<$0.01'
  return `$${usd.toFixed(2)}`
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60_000).toFixed(1)}m`
}

/**
 * 顶栏 Token 用量环形指示器 + 下拉明细卡。
 * web 版数据源为 ChatAgentApi（usage/contextUsage），无 desktop 的
 * autoCompactThreshold/isAutoCompactEnabled 字段，阈值刻度不渲染。
 */
export function CostCircle({ agent }: { agent: ChatAgentApi }): React.JSX.Element {
  const usage = agent.usage
  const contextUsage = agent.contextUsage
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)

  const pct = useMemo(() => contextUsage?.percentage ?? 0, [contextUsage])
  const maxTokens = useMemo(() => contextUsage?.maxTokens ?? 200_000, [contextUsage])

  const toggle = useCallback(() => setOpen((v) => !v), [])
  const close = useCallback(() => setOpen(false), [])

  // 圆形进度环参数
  const size = 18
  const strokeWidth = 2
  const radius = (size - strokeWidth) / 2
  const circumference = 2 * Math.PI * radius
  const offset = circumference * (1 - Math.min(pct, 100) / 100)

  // 上下文窗口使用率：高时变色提醒压缩（>85% 红 = 紧急压缩，>70% 黄 = 建议压缩，否则主题灰）
  const color = pct > 85 ? '#ef4444' : pct > 70 ? '#f59e0b' : 'var(--grey-100)'

  return (
    <div className="relative shrink-0">
      <button
        ref={triggerRef}
        onClick={toggle}
        title={`Token 用量: ${pct}%`}
        className="size-6 flex items-center justify-center rounded-md hover:bg-[var(--overlay-hover)] transition-colors"
      >
        <svg width={size} height={size} className="-rotate-90">
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke="var(--bg-layer-02)"
            strokeWidth={strokeWidth}
          />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={color}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            style={{ transition: 'stroke-dashoffset 0.3s ease' }}
          />
        </svg>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={close} />
          <div
            className={[
              'absolute right-0 top-full mt-2 z-50',
              'w-[min(360px,calc(100vw-1.5rem))] max-h-[520px] overflow-y-auto',
              'bg-[var(--bg-layer-01)] border border-[var(--border-muted)] rounded-xl shadow-2xl'
            ].join(' ')}
          >
            {/* 头部：Token 统计 */}
            <div className="px-4 pt-4 pb-3 border-b border-[var(--border-muted)]">
              <h3 className="text-[13px] font-semibold text-[var(--text-base)]">会话用量</h3>
            </div>

            {/* Token 环形图 */}
            {contextUsage && (
              <div className="px-4 py-3 flex items-center gap-4 border-b border-[var(--border-muted)]">
                <svg width={64} height={64} className="-rotate-90 shrink-0">
                  <circle
                    cx={32}
                    cy={32}
                    r={28}
                    fill="none"
                    stroke="var(--bg-layer-02)"
                    strokeWidth={5}
                  />
                  <circle
                    cx={32}
                    cy={32}
                    r={28}
                    fill="none"
                    stroke={color}
                    strokeWidth={5}
                    strokeLinecap="round"
                    strokeDasharray={2 * Math.PI * 28}
                    strokeDashoffset={2 * Math.PI * 28 * (1 - Math.min(pct, 100) / 100)}
                  />
                  <text
                    x={32}
                    y={32}
                    textAnchor="middle"
                    dy="0.35em"
                    className="text-[11px] fill-[var(--text-base)]"
                    transform="rotate(90, 32, 32)"
                  >
                    {pct}%
                  </text>
                </svg>
                <div className="space-y-0.5 min-w-0">
                  <div className="text-[13px] text-[var(--text-base)]">
                    {formatTokens(contextUsage.totalTokens)} / {formatTokens(maxTokens)}
                  </div>
                  <div className="text-[11px] text-[var(--text-faint)]">
                    上下文窗口使用率 {pct}%
                  </div>
                </div>
              </div>
            )}

            {/* 接近上限：提示 + 手动压缩入口（触发后由 ChatLayout 发送 /compact） */}
            {contextUsage && pct > 85 && (
              <div className="px-4 py-2.5 flex items-center justify-between gap-2 border-b border-[var(--border-muted)]">
                <span className="text-[11px] text-[var(--text-muted)]">
                  上下文接近上限，将自动压缩
                </span>
                <button
                  onClick={() => {
                    useCompactRequestStore.getState().requestCompact()
                    close()
                  }}
                  className="text-[11px] px-2 py-1 rounded-md bg-[var(--bg-layer-02)] text-[var(--text-base)] hover:bg-[var(--overlay-hover)] transition-colors shrink-0"
                >
                  立即压缩
                </button>
              </div>
            )}

            {/* 详细统计 */}
            <div className="px-4 py-3 space-y-2 border-b border-[var(--border-muted)]">
              {usage && (
                <>
                  <Row label="输入 Token" value={formatTokens(usage.inputTokens)} />
                  <Row label="输出 Token" value={formatTokens(usage.outputTokens)} />
                  <Row label="缓存读取" value={formatTokens(usage.cacheReadTokens)} />
                  <Row label="缓存写入" value={formatTokens(usage.cacheCreationTokens)} />
                  <Row
                    label="合计"
                    value={formatTokens(usage.inputTokens + usage.outputTokens)}
                    bold
                  />
                </>
              )}
              {!usage && (
                <p className="text-[12px] text-[var(--text-faint)] text-center py-4">
                  暂无 Token 数据
                </p>
              )}
            </div>

            {/* 成本与耗时（web Usage 单对象，字段后端可选） */}
            {usage && (usage.totalCostUsd != null || usage.durationApiMs != null) && (
              <div className="px-4 py-3 space-y-2 border-b border-[var(--border-muted)]">
                {usage.totalCostUsd != null && (
                  <Row label="总费用" value={formatCost(usage.totalCostUsd)} bold />
                )}
                {usage.durationApiMs != null && (
                  <Row label="API 耗时" value={formatDuration(usage.durationApiMs)} />
                )}
                {usage.durationMs != null && (
                  <Row label="总耗时" value={formatDuration(usage.durationMs)} />
                )}
              </div>
            )}

            {/* 上下文分解 */}
            {contextUsage && contextUsage.categories.length > 0 && (
              <div className="px-4 py-3 space-y-2">
                <h4 className="text-[12px] font-semibold text-[var(--text-muted)]">上下文分解</h4>
                {contextUsage.categories
                  .slice()
                  .sort((a, b) => b.tokens - a.tokens)
                  .map((cat) => (
                    <div key={cat.name} className="flex items-center gap-2 text-[12px]">
                      <span
                        className="size-2.5 rounded-[3px] shrink-0"
                        style={{ background: cat.color }}
                      />
                      <span className="flex-1 truncate text-[var(--text-muted)]">{cat.name}</span>
                      <span className="text-[var(--text-base)] tabular-nums">
                        {formatTokens(cat.tokens)}
                      </span>
                    </div>
                  ))}
              </div>
            )}

            {!usage && !contextUsage && (
              <div className="px-4 py-8 text-center text-[12px] text-[var(--text-faint)]">
                发送消息后将自动收集用量数据
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function Row({
  label,
  value,
  bold
}: {
  label: string
  value: string
  bold?: boolean
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between text-[12px]">
      <span className="text-[var(--text-faint)]">{label}</span>
      <span
        className={[
          'tabular-nums',
          bold ? 'text-[var(--text-base)] font-medium' : 'text-[var(--text-muted)]'
        ].join(' ')}
      >
        {value}
      </span>
    </div>
  )
}
