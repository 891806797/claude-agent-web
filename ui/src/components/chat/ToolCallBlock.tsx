import {
  Check,
  Circle,
  CircleDot,
  FileText,
  ListTodo,
  Loader2,
  Search,
  Terminal
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useChatStore } from '@/stores/chat'
import type { ContentBlock, SubagentInfo } from '@/lib/agent-types'

type ToolUseBlock = Extract<ContentBlock, { type: 'tool_use' }>

/**
 * 工具调用特化渲染 —— 按工具名分型：命令类（Bash/PowerShell）显示 command+输出，
 * 文件类（Read/Edit/Write）显示路径与关键参数，Grep 显示 pattern，Todo（TaskCreate/Update）
 * 渲染待办列表，其余通用 JSON。结果优先 tool_use_result 结构化（M2 暂以文本兜底）。
 */
export function ToolCallBlock({ block }: { block: ToolUseBlock }): React.JSX.Element {
  const input = block.input as Record<string, unknown>
  // 子代理进度内联：按 toolUseId 查活跃态；结果已回填后不再显示运行指示
  const subagent = useChatStore((s) => (!block.result ? s.subagentByToolUse[block.id] : undefined))
  return (
    <div className="flex flex-col gap-1 text-xs">
      <ToolHeader name={block.name} input={input} />
      <SubagentInline info={subagent} />
      <TodoBlock input={input} />
      <ResultBlock block={block} />
    </div>
  )
}

/** 子代理运行指示（内联到 Task/Agent tool_use block；无活跃态或已出结果时不渲染） */
function SubagentInline({ info }: { info: SubagentInfo | undefined }): React.JSX.Element | null {
  if (!info) return null
  return (
    <div className="flex items-center gap-1.5 pl-1 text-muted-foreground">
      <Loader2 className="size-3 animate-spin text-primary" />
      <span>
        子代理运行中{info.subagentType ? `（${info.subagentType}）` : ''}
        {info.lastToolName
          ? ` · 正在 ${info.lastToolName}`
          : info.description
            ? ` · ${info.description}`
            : ''}
      </span>
    </div>
  )
}

function ToolHeader({
  name,
  input
}: {
  name: string
  input: Record<string, unknown>
}): React.JSX.Element {
  const icon = toolIcon(name)
  const summary = toolSummary(name, input)
  return (
    <div className="flex items-center gap-1.5 font-medium text-foreground">
      {icon}
      <span>{name}</span>
      {summary && <span className="truncate text-muted-foreground">· {summary}</span>}
    </div>
  )
}

function toolIcon(name: string): React.JSX.Element {
  const cls = 'size-3.5 text-muted-foreground'
  if (name === 'Bash' || name === 'PowerShell') return <Terminal className={cls} />
  if (name === 'Read' || name === 'Write' || name === 'Edit' || name === 'NotebookEdit')
    return <FileText className={cls} />
  if (name === 'Grep' || name === 'Glob') return <Search className={cls} />
  if (name === 'TaskCreate' || name === 'TaskUpdate') return <ListTodo className={cls} />
  return <CircleDot className={cls} />
}

function toolSummary(name: string, input: Record<string, unknown>): string {
  if (name === 'Bash' || name === 'PowerShell') return String(input.command ?? '').slice(0, 80)
  if (name === 'Read' || name === 'Write' || name === 'Edit') return String(input.file_path ?? '')
  if (name === 'Grep') return String(input.pattern ?? '')
  if (name === 'Glob') return String(input.pattern ?? '')
  if (name === 'TaskCreate') return `${(input.todos as unknown[] | undefined)?.length ?? 0} 项`
  return ''
}

/** Todo（TaskCreate/Update）列表渲染 */
function TodoBlock({ input }: { input: Record<string, unknown> }): React.JSX.Element | null {
  const todos = input.todos
  if (!Array.isArray(todos)) return null
  return (
    <ul className="flex flex-col gap-0.5 pl-1">
      {todos.map((t, i) => {
        const item = (t ?? {}) as { content?: string; status?: string; activeForm?: string }
        const status = String(item.status ?? 'pending')
        return (
          <li key={i} className="flex items-start gap-1.5">
            <TodoStatus status={status} />
            <span
              className={cn(
                'text-muted-foreground',
                status === 'completed' && 'text-muted-foreground line-through',
                status === 'in_progress' && 'text-foreground'
              )}
            >
              {item.activeForm || item.content || ''}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

function TodoStatus({ status }: { status: string }): React.JSX.Element {
  if (status === 'completed') return <Check className="size-3 text-emerald-600" />
  if (status === 'in_progress') return <CircleDot className="size-3 text-primary" />
  return <Circle className="size-3 text-muted-foreground" />
}

function ResultBlock({ block }: { block: ToolUseBlock }): React.JSX.Element | null {
  if (!block.result) return null
  // 命令类结果用等宽；其余也用等宽兜底（code/diff 视觉）
  return (
    <div
      className={cn(
        'max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded border-l-2 bg-muted/30 p-2 font-mono text-[11px]',
        block.resultError
          ? 'border-destructive text-destructive'
          : 'border-border text-muted-foreground'
      )}
    >
      {block.result}
    </div>
  )
}
