/**
 * B 类工具结果渲染器的共享样式常量。
 * 从 ChatMessageList.tsx 迁入，集中收口，主文件与各结果组件共享同一份。
 */

/** 左侧占位 gutter 宽度（对齐 claude-code ● 在 w-5 的布局） */
export const GUTTER = 'w-5 shrink-0 select-none text-right'
export const GUTTER_TEXT = 'text-[var(--text-base)]'

/** 结果竖线颜色 */
export const LINE_COLOR = 'border-[var(--border-muted)]'
export const LINE_ERROR = 'border-red-400'

/** 短结果直显的行数阈值 */
export const RESULT_PREVIEW_LINES = 3
