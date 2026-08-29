import { memo, useState, type ReactNode } from 'react'
import { ChevronRightIcon } from 'lucide-react'
import { Markdown } from '../Markdown'
import { GUTTER, LINE_COLOR, LINE_ERROR, RESULT_PREVIEW_LINES } from './shared'

/**
 * 结果渲染的布局原语，所有 B 类结果组件共享，保证视觉一致、避免重复。
 * 嵌套关系：ResultShell（GUTTER + 竖线 + 内容槽）→ 内容槽内放状态行 / Foldable / Markdown。
 */

/** 结果外壳：GUTTER 占位 + 左竖线（error 态变红）+ 内容槽。 */
export const ResultShell = memo(function ResultShell({
  children,
  error
}: {
  children: ReactNode
  error?: boolean
}): React.JSX.Element {
  return (
    <div className="flex flex-row items-start">
      <span className={`${GUTTER} shrink-0`} aria-hidden />
      <div className={`flex flex-row items-start border-l-2 ${error ? LINE_ERROR : LINE_COLOR}`}>
        <span className="w-1.5 shrink-0" />
        <div className="flex-1 min-w-0 py-0.5">{children}</div>
      </div>
    </div>
  )
})

/** dim 单行提示（无竖线）：「任务仍在运行…」「命令已中断」等状态文案。 */
export const DimNote = memo(function DimNote({
  children
}: {
  children: ReactNode
}): React.JSX.Element {
  return (
    <div className="flex flex-row items-start">
      <span className={`${GUTTER} shrink-0`} aria-hidden />
      <div className="flex-1 min-w-0 py-0.5">
        <span className="text-[11px] text-[var(--text-faint)]">{children}</span>
      </div>
    </div>
  )
})

/** 可折叠文本块（无 GUTTER，嵌入 ResultShell 内容槽）：短直显 Markdown，长则折叠 + 展开按钮。 */
export const Foldable = memo(function Foldable({
  content,
  error
}: {
  content: string
  error?: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const lines = content.split('\n')
  const isShort = lines.length <= RESULT_PREVIEW_LINES && content.length <= 500
  const textClass = error ? 'text-red-400' : 'text-[var(--text-faint)]'

  if (isShort) {
    return <Markdown dimColor>{content}</Markdown>
  }
  return (
    <>
      <div
        className={`relative overflow-hidden transition-[max-height] duration-300 ease-in-out ${
          open ? 'max-h-[3000px]' : 'max-h-[4.5rem]'
        }`}
      >
        {open ? (
          <Markdown dimColor>{content}</Markdown>
        ) : (
          <pre className="text-[11px] text-[var(--text-faint)] whitespace-pre-wrap break-words font-mono">
            {content.slice(0, 500)}
          </pre>
        )}
        {!open && (
          <div className="absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-[var(--bg-base)] to-transparent pointer-events-none" />
        )}
      </div>
      <button
        onClick={() => setOpen(!open)}
        className={`text-[11px] hover:text-[var(--text-muted)] select-none cursor-pointer inline-flex items-center gap-1 mt-0.5 ${textClass}`}
      >
        <ChevronRightIcon
          className={`size-2.5 transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
        />
        {open ? '收起' : `展开全部 · ${content.length.toLocaleString()} 字符`}
        {error && <span className="text-red-400"> · 错误</span>}
      </button>
    </>
  )
})
