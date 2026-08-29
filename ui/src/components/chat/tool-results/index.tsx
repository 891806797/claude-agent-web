import { memo } from 'react'
import { hasGrepFileTags, hasPersistedOutput, hasTaskOutput, tryParseJson } from '@/lib/xml-tags'
import { BashResult } from './BashResult'
import { GrepResult } from './GrepResult'
import { JsonResult } from './JsonResult'
import { ReadResult } from './ReadResult'
import { ResultBlock } from './ResultBlock'
import { TaskOutputResult } from './TaskOutputResult'

/**
 * 工具结果分流器：按工具 name 精确路由到特化渲染器（对齐 claude-code 每工具一个
 * renderToolResultMessage 的模式）；name 缺失（历史 ToolResultBubble）走 content 嗅探 fallback；
 * 未命中走默认 ResultBlock。
 *
 * name 是强信号（tool_use block 携带，100% 准确）；嗅探是弱信号，仅覆盖历史消息边界。
 */
const TASK_OUTPUT_NAMES = new Set(['TaskOutput', 'BashOutput', 'AgentOutput'])
const BASH_NAMES = new Set(['Bash', 'PowerShell'])
const JSON_NAMES = new Set([
  'TaskStop',
  'SendMessage',
  'TeamCreate',
  'TeamDelete',
  'ReadMcpResource',
  'ListMcpResources'
])

export interface ToolResultRendererProps {
  /** 工具名（来自 tool_use block）；历史消息可能缺失 */
  name?: string
  /** 工具输入（预留，如未来 Grep 按 output_mode 分流） */
  input?: Record<string, unknown>
  content: string
  error?: boolean
}

export const ToolResultRenderer = memo(function ToolResultRenderer({
  name,
  content,
  error
}: ToolResultRendererProps): React.JSX.Element {
  // 主路径：按 name 精确路由
  if (name) {
    if (TASK_OUTPUT_NAMES.has(name)) return <TaskOutputResult content={content} error={error} />
    if (BASH_NAMES.has(name)) return <BashResult content={content} error={error} />
    if (name === 'Read') return <ReadResult content={content} error={error} />
    if (name === 'Grep') return <GrepResult content={content} error={error} />
    if (JSON_NAMES.has(name)) return <JsonResult content={content} error={error} />
  }

  // 边界：name 缺失（历史消息）→ content 嗅探 fallback
  if (hasTaskOutput(content)) return <TaskOutputResult content={content} error={error} />
  if (hasPersistedOutput(content)) return <BashResult content={content} error={error} />
  if (hasGrepFileTags(content)) return <GrepResult content={content} error={error} />
  if (tryParseJson(content)) return <JsonResult content={content} error={error} />

  // 默认：纯文本或未知工具
  return <ResultBlock content={content} error={error} />
})
