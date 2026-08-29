import type { ApprovalRequest } from '@/lib/agent-types'
import { ApprovalShell, type OnApprove } from './ApprovalShell'

export function WriteApproval({
  request,
  onApprove
}: {
  request: ApprovalRequest
  onApprove: OnApprove
}): React.JSX.Element {
  const fp = (request.input as { file_path?: string }).file_path ?? ''
  const content = (request.input as { content?: string }).content
  return (
    <ApprovalShell toolName={request.toolName} onApprove={onApprove}>
      <div className="mb-1.5 font-mono text-[12px] text-[var(--text-muted)]">{fp}</div>
      {typeof content === 'string' && (
        <pre className="whitespace-pre-wrap rounded border border-[var(--border-muted)] bg-[var(--bg-layer-02)] p-2 font-mono text-[12px] text-[var(--text-base)]">
          {content.slice(0, 2000)}
          {content.length > 2000 ? '\n…[truncated]' : ''}
        </pre>
      )}
    </ApprovalShell>
  )
}
