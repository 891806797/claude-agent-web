import type { ApprovalRequest } from '@/lib/agent-types'
import type { OnApprove } from './ApprovalShell'
import { BashApproval } from './BashApproval'
import { WriteApproval } from './WriteApproval'
import { AskUserQuestionApproval } from './AskUserQuestionApproval'
import { FallbackApproval } from './FallbackApproval'

/** 按 toolName 分发到对应的审批 UI（仿 Claude Code permissionComponentForTool） */
export function PermissionRequest({
  request,
  onApprove
}: {
  request: ApprovalRequest
  onApprove: OnApprove
}): React.JSX.Element {
  switch (request.toolName) {
    case 'Bash':
    case 'PowerShell':
      return <BashApproval request={request} onApprove={onApprove} />
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return <WriteApproval request={request} onApprove={onApprove} />
    case 'AskUserQuestion':
      return <AskUserQuestionApproval request={request} onApprove={onApprove} />
    default:
      return <FallbackApproval request={request} onApprove={onApprove} />
  }
}
