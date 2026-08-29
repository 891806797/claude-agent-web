import { memo } from 'react'
import { getStatusColor, parseTaskOutput } from '@/lib/xml-tags'
import { DimNote, Foldable, ResultShell } from './primitives'

/**
 * TaskOutputTool 结果渲染（对齐 claude-code TaskOutputResultDisplay）。
 * 解析 envelope：<retrieval_status>/<task_id>/<task_type>/<status>/<exit_code>/<output>/<error>
 * 信息架构：状态行（task_type [status] + exit 徽章）→ error → output 折叠。
 */
export const TaskOutputResult = memo(function TaskOutputResult({
  content
}: {
  content: string
  error?: boolean
}): React.JSX.Element {
  const d = parseTaskOutput(content)

  if (!d.hasTask) return <DimNote>无任务输出</DimNote>
  if (d.retrieval_status === 'timeout' || d.status === 'running') {
    return <DimNote>任务仍在运行…</DimNote>
  }
  if (d.retrieval_status === 'not_ready') return <DimNote>任务尚未就绪</DimNote>

  const hasErr = !!d.error
  return (
    <ResultShell error={hasErr}>
      <div className="flex flex-col gap-0.5">
        <div className="text-[11px] inline-flex flex-wrap items-center gap-1.5">
          <code className="font-mono text-[var(--text-muted)]">{d.task_type ?? 'task'}</code>
          <span className={getStatusColor(d.status)}>[{d.status ?? 'unknown'}]</span>
          {d.exit_code !== null && (
            <span
              className={`tabular-nums ${d.exit_code === '0' ? 'text-emerald-400' : 'text-red-400'}`}
            >
              exit {d.exit_code}
            </span>
          )}
        </div>
        {d.error && <div className="text-[11px] text-red-400">{d.error}</div>}
        {d.output && <Foldable content={d.output} error={hasErr} />}
      </div>
    </ResultShell>
  )
})
