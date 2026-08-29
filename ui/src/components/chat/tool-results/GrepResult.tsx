import { memo } from 'react'
import { extractFileList, hasGrepFileTags } from '@/lib/xml-tags'
import { ResultShell } from './primitives'
import { ResultBlock } from './ResultBlock'

/**
 * Grep 结果渲染：files_with_matches 模式（<file> 列表）提取为文件清单 + 计数；
 * content/count 模式（带行号文本）复用 ResultBlock。
 */
export const GrepResult = memo(function GrepResult({
  content,
  error
}: {
  content: string
  error?: boolean
}): React.JSX.Element {
  if (!hasGrepFileTags(content)) return <ResultBlock content={content} error={error} />

  const files = extractFileList(content)
  const match = content.match(/Found (\d+) files?/i)
  const total = match ? parseInt(match[1], 10) : files.length

  return (
    <ResultShell>
      <div className="flex flex-col gap-0.5">
        <div className="text-[11px] text-[var(--text-faint)]">找到 {total} 个文件</div>
        <pre className="text-[11px] text-[var(--text-faint)] whitespace-pre-wrap break-words font-mono">
          {files.join('\n')}
        </pre>
      </div>
    </ResultShell>
  )
})
