import { memo } from 'react'
import { ResultShell, Foldable } from './primitives'

/**
 * 默认工具结果渲染 = ResultShell 包 Foldable。短内容直显，长内容折叠。
 * 作为 ToolResultRenderer 的默认 fallback；其他特化结果组件也复用本组件处理纯文本正文。
 */
export const ResultBlock = memo(function ResultBlock({
  content,
  error
}: {
  content: string
  error?: boolean
}): React.JSX.Element {
  return (
    <ResultShell error={error}>
      <Foldable content={content} error={error} />
    </ResultShell>
  )
})
