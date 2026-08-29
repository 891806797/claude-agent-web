import { memo } from 'react'
import { stripSystemReminders } from '@/lib/xml-tags'
import { DimNote } from './primitives'
import { ResultBlock } from './ResultBlock'

/**
 * Read 结果渲染：剥离模型专属 <system-reminder>（空文件/越界/malware 提醒），
 * 不让其泄漏到用户视图；剩余带行号的文件内容继续展示。
 */
export const ReadResult = memo(function ReadResult({
  content,
  error
}: {
  content: string
  error?: boolean
}): React.JSX.Element {
  const cleaned = stripSystemReminders(content)
  if (!cleaned) return <DimNote>（文件为空或仅含系统提醒）</DimNote>
  return <ResultBlock content={cleaned} error={error} />
})
