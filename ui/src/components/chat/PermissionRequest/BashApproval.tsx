import type { ApprovalRequest } from '@/lib/agent-types'
import { ApprovalShell, type OnApprove } from './ApprovalShell'

export function BashApproval({
  request,
  onApprove
}: {
  request: ApprovalRequest
  onApprove: OnApprove
}): React.JSX.Element {
  const cmd =
    (request.input as { command?: string }).command ?? JSON.stringify(request.input, null, 2)
  return (
    <ApprovalShell toolName={request.toolName} onApprove={onApprove}>
      <pre className="whitespace-pre-wrap rounded border border-[var(--border-muted)] bg-[var(--bg-layer-02)] p-2 font-mono text-[12px] text-[var(--text-base)]">
        {cmd}
      </pre>
    </ApprovalShell>
  )
}
