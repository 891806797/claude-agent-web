import type React from 'react'
import { Button } from '@/components/ui/button'

export type OnApprove = (
  allowed: boolean,
  modifiedInput?: Record<string, unknown>,
  feedback?: string,
  alwaysAllow?: boolean
) => void

/**
 * 公共审批外壳（dock 风格，与 AskUserQuestionApproval 视觉一致）：
 * header（工具名）+ content（自定义内容）+ footer（拒绝/允许/本次会话总是允许）。
 * header/footer 固定，content 区独立滚动。
 */
export function ApprovalShell({
  toolName,
  children,
  onApprove
}: {
  toolName: string
  children?: React.ReactNode
  onApprove: OnApprove
}): React.JSX.Element {
  return (
    <div className="mx-4 my-2 rounded-lg border border-[var(--border-base)] bg-[var(--bg-layer-01)] shadow-[var(--elevation-raised)] overflow-hidden flex flex-col max-h-[55vh]">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-[var(--border-muted)] shrink-0">
        <span className="size-2 rounded-full bg-[var(--grey-500)] animate-pulse" />
        <span className="text-[13px] font-medium text-[var(--text-base)]">工具调用审批</span>
        <span className="rounded border border-[var(--border-base)] bg-[var(--bg-layer-02)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--text-base)]">
          {toolName}
        </span>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3">{children}</div>

      <div className="flex items-center gap-2 px-4 py-2.5 border-t border-[var(--border-muted)] shrink-0">
        <Button
          variant="outline"
          size="sm"
          className="border-[var(--border-base)] bg-[var(--bg-layer-02)] text-[var(--text-base)] hover:bg-[var(--overlay-hover)]"
          onClick={() => onApprove(false, undefined, '用户拒绝了此工具调用')}
        >
          拒绝
        </Button>
        <div className="flex-1" />
        <Button variant="secondary" size="sm" onClick={() => onApprove(true)}>
          允许
        </Button>
        <Button
          size="sm"
          className="bg-[var(--grey-100)] text-white hover:bg-[var(--grey-50)]"
          onClick={() => onApprove(true, undefined, undefined, true)}
        >
          本次会话总是允许
        </Button>
      </div>
    </div>
  )
}
