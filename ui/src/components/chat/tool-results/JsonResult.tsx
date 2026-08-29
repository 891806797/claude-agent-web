import { memo } from 'react'
import { tryParseJson } from '@/lib/xml-tags'
import { Foldable, ResultShell } from './primitives'
import { ResultBlock } from './ResultBlock'

/**
 * JSON 工具结果渲染（TaskStop/SendMessage/TeamCreate/TeamDelete/ReadMcpResource/ListMcpResources）。
 * content 为 JSON 时格式化 + 包 ```json 代码块（借 Markdown 高亮 key/value）；否则回退 ResultBlock。
 */
export const JsonResult = memo(function JsonResult({
  content,
  error
}: {
  content: string
  error?: boolean
}): React.JSX.Element {
  const parsed = tryParseJson(content)
  if (!parsed) return <ResultBlock content={content} error={error} />

  const formatted = '```json\n' + JSON.stringify(parsed, null, 2) + '\n```'
  return (
    <ResultShell error={error}>
      <Foldable content={formatted} error={error} />
    </ResultShell>
  )
})
