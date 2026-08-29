import { memo } from 'react'
import { hasBashAbortError, hasPersistedOutput, parsePersistedOutput } from '@/lib/xml-tags'
import { DimNote, Foldable, ResultShell } from './primitives'
import { ResultBlock } from './ResultBlock'

/**
 * Bash / PowerShell 结果渲染。
 * 识别三种态：中断（<error>aborted before completion</error>）、
 * 大输出落盘（<persisted-output>）、普通 stdout。普通态复用 ResultBlock。
 */
export const BashResult = memo(function BashResult({
  content,
  error
}: {
  content: string
  error?: boolean
}): React.JSX.Element {
  if (hasBashAbortError(content)) return <DimNote>命令已中断</DimNote>

  if (hasPersistedOutput(content)) {
    const p = parsePersistedOutput(content)
    return (
      <ResultShell>
        <div className="flex flex-col gap-0.5">
          <div className="text-[11px] text-[var(--text-faint)]">
            输出过大{p.savedPath ? `，已保存：${p.savedPath}` : ''}
          </div>
          {p.preview && <Foldable content={p.preview} />}
        </div>
      </ResultShell>
    )
  }

  return <ResultBlock content={content} error={error} />
})
