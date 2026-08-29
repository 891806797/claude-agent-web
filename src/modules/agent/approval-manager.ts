import type { ApprovalOutcome } from './sse-events'

/** 审批挂起时长（与 SDK 工具级 signal 共同决定 canUseTool 的返回时机）；approval_request 广播同口径换算 expiresAt */
export const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000

/**
 * 需人工审批的工具集（用户拍板的放宽粒度）：
 * - 命令类 Bash / PowerShell —— 弹「同意/拒绝/总是允许」卡，允许编辑 command
 * - AskUserQuestion —— 走同一挂起链路（问卷语义，见 canUseTool 调用点）
 * Edit/Write/NotebookEdit 等文件工具与只读工具一律直接放行，不产生审批卡。
 */
const APPROVAL_TOOLS = new Set(['Bash', 'PowerShell'])

/** 是否需要走人工审批（canUseTool 调用点用） */
export function needsApproval(toolName: string): boolean {
  return toolName === 'AskUserQuestion' || APPROVAL_TOOLS.has(toolName)
}

export interface ApprovalDecision {
  allowed: boolean
  modifiedInput?: Record<string, unknown>
  feedback?: string
  alwaysAllow?: boolean
}

interface PendingApproval {
  toolName: string
  input: Record<string, unknown>
  suggestions?: unknown[]
  /** 挂起时刻（重放时换算剩余倒计时） */
  createdAt: number
  resolve: (d: ApprovalDecision) => void
  /** 关闭路径：以 outcome=closed 终结（与作答 allow/deny 区分），只触发一次 onSettled */
  close: () => void
  timer: ReturnType<typeof setTimeout>
  toolSignalHandler: () => void
  toolSignal: AbortSignal
}

export interface PendingApprovalView {
  toolCallId: string
  toolName: string
  input: Record<string, unknown>
  suggestions?: unknown[]
  /** 过期时刻（ms 时间戳）：前端据此恢复倒计时 */
  expiresAt: number
}

/**
 * 会话级审批管理器（每个 SessionContext 独享一个实例，无需 sessionId 字段）。
 * - canUseTool 钩子调 request() 挂起 Promise；审批接口调 resolve() 作答
 * - 任何终结路径（作答/超时/会话关闭）都触发 onSettled → 广播 approval_settled
 * - 「本次会话总是允许」为内存态（对齐 claude-code accept-session，不持久化）
 * 移植自 claude-agent-desktop approval-manager，按 web 多会话实例化改造。
 */
export class ApprovalManager {
  private pending = new Map<string, PendingApproval>()
  private sessionAllowed = new Set<string>()

  constructor(
    /** 会话级 abort signal（关会话时清空全部挂起） */
    private readonly sessionSignal: AbortSignal,
    private readonly onSettled: (
      toolCallId: string,
      outcome: ApprovalOutcome,
      reason?: string,
    ) => void,
  ) {}

  isAlwaysAllowed(toolName: string): boolean {
    return this.sessionAllowed.has(toolName)
  }

  /** 当前挂起审批快照（SSE attach 时重放 approval_request 用） */
  getPending(): PendingApprovalView[] {
    const result: PendingApprovalView[] = []
    for (const [toolCallId, entry] of this.pending) {
      result.push({
        toolCallId,
        toolName: entry.toolName,
        input: entry.input,
        ...(entry.suggestions ? { suggestions: entry.suggestions } : {}),
        expiresAt: entry.createdAt + APPROVAL_TIMEOUT_MS,
      })
    }
    return result
  }

  request(req: {
    toolCallId: string
    toolName: string
    input: Record<string, unknown>
    /** SDK 传入的工具级 signal（turn 被取消时触发） */
    signal: AbortSignal
    suggestions?: unknown[]
  }): Promise<ApprovalDecision> {
    // 会话级总是允许：命中直接放行，不挂起
    if (this.isAlwaysAllowed(req.toolName)) {
      return Promise.resolve({ allowed: true })
    }
    return new Promise((resolve) => {
      const cleanup = (): void => {
        clearTimeout(entry.timer)
        entry.toolSignal.removeEventListener('abort', entry.toolSignalHandler)
        this.pending.delete(req.toolCallId)
      }

      const settle = (outcome: ApprovalOutcome, d: ApprovalDecision, reason?: string): void => {
        cleanup()
        resolve(d)
        this.onSettled(req.toolCallId, outcome, reason)
      }

      const entry: PendingApproval = {
        toolName: req.toolName,
        input: req.input,
        ...(req.suggestions ? { suggestions: req.suggestions } : {}),
        createdAt: Date.now(),
        toolSignal: req.signal,
        toolSignalHandler: () => settle('closed', { allowed: false, feedback: '已中断' }, '已中断'),
        timer: setTimeout(() => {
          settle(
            'timeout',
            { allowed: false, feedback: '审批超时（5 分钟未响应）' },
            '审批超时（5 分钟未响应）',
          )
        }, APPROVAL_TIMEOUT_MS),
        resolve: (d: ApprovalDecision): void => {
          cleanup()
          resolve(d)
          this.onSettled(req.toolCallId, d.allowed ? 'allow' : 'deny', d.feedback)
        },
        close: (): void =>
          settle('closed', { allowed: false, feedback: '会话已关闭' }, '会话已关闭'),
      }

      if (req.signal.aborted || this.sessionSignal.aborted) {
        entry.toolSignalHandler()
        return
      }
      req.signal.addEventListener('abort', entry.toolSignalHandler, { once: true })
      this.pending.set(req.toolCallId, entry)
    })
  }

  /** 用户作答（审批接口调用）；不存在（已处理/超时/关闭）返回 false → 409 */
  resolve(toolCallId: string, response: ApprovalDecision): boolean {
    const entry = this.pending.get(toolCallId)
    if (!entry) return false
    if (response.allowed && response.alwaysAllow) {
      this.sessionAllowed.add(entry.toolName)
    }
    entry.resolve(response)
    return true
  }

  /** 清空全部挂起（会话关闭时）：deny 决策 + approval_settled(closed)，防 Promise 泄漏与子进程卡死 */
  closeAll(): void {
    for (const [, entry] of [...this.pending]) {
      entry.close()
    }
  }
}
