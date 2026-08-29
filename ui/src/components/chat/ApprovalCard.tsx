import { ShieldCheck, ShieldX } from 'lucide-react'
import { type ChangeEvent, useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import type { PendingApproval } from '@/lib/agent-types'

/** 审批作答载荷（由 useChatAgent 透传给 agentApi.approve） */
export interface ApprovalResolution {
  allowed: boolean
  updatedInput?: Record<string, unknown>
  feedback?: string
  alwaysAllow?: boolean
}

function useRemaining(expiresAt: number): number {
  const [remaining, setRemaining] = useState(() => Math.max(0, expiresAt - Date.now()))
  useEffect(() => {
    const t = setInterval(() => setRemaining(Math.max(0, expiresAt - Date.now())), 1000)
    return () => clearInterval(t)
  }, [expiresAt])
  return remaining
}

function fmt(ms: number): string {
  const s = Math.ceil(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/**
 * 审批卡（M2 Fallback 版）：Bash/PowerShell 可编辑 command；其余工具只读 input + 允许/拒绝。
 * AskUserQuestion 问卷特化、5min 倒计时固化留 M3。已超时/已答时按钮禁用。
 */
export function ApprovalCard({
  approval,
  onResolve,
  settled
}: {
  approval: PendingApproval
  onResolve: (r: ApprovalResolution) => void
  settled?: { outcome: string; reason?: string }
}): React.JSX.Element {
  const isCmd = approval.toolName === 'Bash' || approval.toolName === 'PowerShell'
  const [command, setCommand] = useState(isCmd ? String(approval.input.command ?? '') : '')
  const [alwaysAllow, setAlwaysAllow] = useState(false)
  const remaining = useRemaining(approval.expiresAt)
  const expired = remaining <= 0 || settled !== undefined

  if (settled) {
    return (
      <div className="rounded-lg border bg-muted/40 p-3 text-xs text-muted-foreground">
        审批已结束 · {settled.outcome}
        {settled.reason ? `（${settled.reason}）` : ''}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-card p-3 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Badge variant="secondary">{approval.toolName}</Badge>
          <span className="text-xs text-muted-foreground">需要审批</span>
        </div>
        <span
          className={
            remaining < 60_000
              ? 'text-xs font-medium text-destructive'
              : 'text-xs text-muted-foreground'
          }
        >
          {fmt(remaining)}
        </span>
      </div>

      {isCmd ? (
        <Textarea
          value={command}
          onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setCommand(e.target.value)}
          rows={2}
          className="font-mono text-xs"
          aria-label="可编辑命令"
        />
      ) : (
        <pre className="overflow-x-auto rounded bg-muted/60 p-2 text-[11px] text-muted-foreground">
          {JSON.stringify(approval.input, null, 2)}
        </pre>
      )}

      <div className="flex items-center gap-3">
        {isCmd && (
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={alwaysAllow}
              onChange={(e) => setAlwaysAllow(e.target.checked)}
              className="size-3.5"
            />
            本次会话总是允许
          </label>
        )}
        <div className="ml-auto flex gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => onResolve({ allowed: false, feedback: '用户拒绝了此工具调用' })}
            disabled={expired}
          >
            <ShieldX className="size-3.5" />
            拒绝
          </Button>
          <Button
            size="sm"
            onClick={() =>
              onResolve({
                allowed: true,
                ...(isCmd ? { updatedInput: { command } } : {}),
                ...(alwaysAllow ? { alwaysAllow: true } : {})
              })
            }
            disabled={expired}
          >
            <ShieldCheck className="size-3.5" />
            允许
          </Button>
        </div>
      </div>
    </div>
  )
}
