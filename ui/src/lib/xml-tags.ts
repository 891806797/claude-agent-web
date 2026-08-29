/**
 * XML 标签解析工具 — 对齐 Claude Code 的 extractTag + 常量模式。
 *
 * 三层分离中的「解析层」：纯函数，零 React 依赖，可被任意组件复用、可单测。
 * （照搬自 claude-agent-desktop，用于用户消息与工具结果的标签嗅探/剥离）
 */

/** 正则提取 <tagName>...</tagName> 内容（不跨嵌套，跨行） */
export function extractTag(content: string, tagName: string): string | null {
  const re = new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`, 's')
  const m = content.match(re)
  return m?.[1]?.trim() ?? null
}

/** 提取带属性的开标签正文：<tag k="v">...content...</tag>（标签名可含连字符） */
export function extractTagContent(tag: string, content: string): string | null {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i')
  const m = content.match(re)
  return m?.[1]?.trim() ?? null
}

/** 提取开标签的属性：<tag k1="v1" k2="v2"> → { k1: v1, k2: v2 } */
export function parseXmlAttrs(tag: string, content: string): Record<string, string> {
  const re = new RegExp(`<${tag}\\b([^>]*)>`, 'i')
  const m = content.match(re)
  if (!m) return {}
  const attrs: Record<string, string> = {}
  const attrRe = /([\w-]+)\s*=\s*"([^"]*)"/g
  let am: RegExpExecArray | null
  while ((am = attrRe.exec(m[1])) !== null) attrs[am[1]] = am[2]
  return attrs
}

// ── 标签名常量 ──

export const TASK_NOTIFICATION = 'task-notification'
export const STATUS = 'status'
export const SUMMARY = 'summary'
export const COMMAND_MESSAGE = 'command-message'
export const COMMAND_NAME = 'command-name'
export const COMMAND_ARGS = 'command-args'
export const BASH_INPUT = 'bash-input'
export const BASH_STDOUT = 'bash-stdout'
export const BASH_STDERR = 'bash-stderr'
export const LOCAL_COMMAND_CAVEAT = 'local-command-caveat'
export const LOCAL_COMMAND_STDOUT = 'local-command-stdout'
export const SYSTEM_REMINDER = 'system-reminder'
export const TICK = 'tick'
export const FILE_PATH = 'file'

// ── TaskOutputTool envelope（下划线，区别于 task-notification 的连字符）──
export const RETRIEVAL_STATUS = 'retrieval_status'
export const TASK_ID = 'task_id'
export const TASK_TYPE = 'task_type'
export const EXIT_CODE = 'exit_code'
export const OUTPUT = 'output'
export const ERROR = 'error'

// ── Bash 大输出 / 中断 ──
export const PERSISTED_OUTPUT = 'persisted-output'

// ── 快速检测 ──

export function hasTaskNotification(content: string): boolean {
  return content.includes(`<${TASK_NOTIFICATION}>`)
}

export function hasCommandMessage(content: string): boolean {
  return content.includes(`<${COMMAND_MESSAGE}>`)
}

export function hasBashInput(content: string): boolean {
  return content.includes(`<${BASH_INPUT}>`)
}

export function hasBashOutput(content: string): boolean {
  return content.startsWith(`<${BASH_STDOUT}>`) || content.startsWith(`<${BASH_STDERR}>`)
}

export function hasLocalCommandCaveat(content: string): boolean {
  return content.includes(`<${LOCAL_COMMAND_CAVEAT}>`)
}

export function hasLocalCommandStdout(content: string): boolean {
  return content.includes(`<${LOCAL_COMMAND_STDOUT}>`)
}

export function hasSystemReminder(content: string): boolean {
  return content.includes(`<${SYSTEM_REMINDER}>`)
}

// ── TaskOutputTool envelope 检测/解析 ──

export function hasTaskOutput(content: string): boolean {
  return content.includes(`<${RETRIEVAL_STATUS}>`)
}

export interface TaskOutputData {
  retrieval_status: string | null
  task_id: string | null
  task_type: string | null
  status: string | null
  exit_code: string | null
  output: string | null
  error: string | null
  hasTask: boolean
}

export function parseTaskOutput(content: string): TaskOutputData {
  const task_id = extractTag(content, TASK_ID)
  return {
    retrieval_status: extractTag(content, RETRIEVAL_STATUS),
    task_id,
    task_type: extractTag(content, TASK_TYPE),
    status: extractTag(content, STATUS),
    exit_code: extractTag(content, EXIT_CODE),
    output: extractTag(content, OUTPUT),
    error: extractTag(content, ERROR),
    hasTask: content.includes(`<${TASK_ID}>`)
  }
}

// ── Bash persisted-output / 中断 ──

export function hasPersistedOutput(content: string): boolean {
  return content.includes(`<${PERSISTED_OUTPUT}>`)
}

export interface PersistedOutputData {
  raw: string
  savedPath: string | null
  preview: string | null
}

export function parsePersistedOutput(content: string): PersistedOutputData {
  const raw = extractTag(content, PERSISTED_OUTPUT) ?? ''
  const pathMatch = raw.match(/saved to:\s*([^\n]+)/i)
  const previewMatch = raw.match(/Preview[^:]*:\s*([\s\S]*)/i)
  return {
    raw,
    savedPath: pathMatch?.[1]?.trim() ?? null,
    preview: previewMatch?.[1]?.trim() ?? null
  }
}

export function hasBashAbortError(content: string): boolean {
  return content.includes('<error>') && content.includes('aborted before completion')
}

// ── Read: 剥离模型专属 system-reminder（区别于 user 文本的 hasSystemReminder）──

export function stripSystemReminders(content: string): string {
  return content.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
}

// ── Grep: files_with_matches 的 <file> 列表 ──

export function extractFileList(content: string): string[] {
  const re = /<file>([\s\S]*?)<\/file>/g
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(content)) !== null) out.push(m[1].trim())
  return out
}

export function hasGrepFileTags(content: string): boolean {
  return content.includes('<file>') && /Found \d+ files?/i.test(content)
}

// ── JSON 工具结果安全解析 ──

export function tryParseJson<T = unknown>(content: string): T | null {
  const s = content.trim()
  if (s[0] !== '{' && s[0] !== '[') return null
  try {
    return JSON.parse(s) as T
  } catch {
    return null
  }
}

// ── task-notification 解析（含子代理 result/usage/worktree）──

export interface TaskUsage {
  total_tokens: number | null
  tool_uses: number | null
  duration_ms: number | null
}

export interface TaskNotificationData {
  taskId: string | null
  toolUseId: string | null
  status: string | null
  summary: string | null
  result: string | null
  usage: TaskUsage | null
  worktreePath: string | null
  worktreeBranch: string | null
}

export function parseTaskNotification(content: string): TaskNotificationData {
  const usageRaw = extractTag(content, 'usage')
  let usage: TaskUsage | null = null
  if (usageRaw) {
    const tt = usageRaw.match(/<total_tokens>(\d+)<\/total_tokens>/)?.[1]
    const tu = usageRaw.match(/<tool_uses>(\d+)<\/tool_uses>/)?.[1]
    const dm = usageRaw.match(/<duration_ms>(\d+)<\/duration_ms>/)?.[1]
    usage = {
      total_tokens: tt ? parseInt(tt, 10) : null,
      tool_uses: tu ? parseInt(tu, 10) : null,
      duration_ms: dm ? parseInt(dm, 10) : null
    }
  }
  return {
    taskId: extractTag(content, 'task-id'),
    toolUseId: extractTag(content, 'tool-use-id'),
    status: extractTag(content, STATUS),
    summary: extractTag(content, SUMMARY),
    result: extractTag(content, 'result'),
    usage,
    worktreePath: extractTag(content, 'worktreePath'),
    worktreeBranch: extractTag(content, 'worktreeBranch')
  }
}

// ── A 类 stub 标签检测（teammate/channel/mcp-resource 等，带属性）──

export function hasUserMemoryInput(c: string): boolean {
  return c.includes('<user-memory-input>')
}
export function hasTeammateMessage(c: string): boolean {
  return c.includes('<teammate-message')
}
export function hasChannelMessage(c: string): boolean {
  return c.includes('<channel ')
}
export function hasMcpResourceUpdate(c: string): boolean {
  return c.includes('<mcp-resource-update') || c.includes('<mcp-polling-update')
}
export function hasForkBoilerplate(c: string): boolean {
  return c.includes('<fork-boilerplate>')
}
export function hasCrossSessionMessage(c: string): boolean {
  return c.includes('<cross-session-message')
}
export function hasGithubWebhook(c: string): boolean {
  return c.includes('<github-webhook-activity>')
}
export function hasIdeContext(c: string): boolean {
  return c.includes('<ide_opened_file') || c.includes('<ide_selection')
}

// ── task-notification 状态色 ──

export function getStatusColor(status: string | null): string {
  switch (status) {
    case 'completed':
      return 'text-emerald-400'
    case 'failed':
      return 'text-red-400'
    case 'killed':
      return 'text-amber-400'
    default:
      return 'text-[var(--text-base)]'
  }
}

// ── 剥离已知 XML 标签，返回纯文本 ──

const KNOWN_TAGS = [
  TASK_NOTIFICATION,
  COMMAND_MESSAGE,
  COMMAND_NAME,
  COMMAND_ARGS,
  BASH_INPUT,
  BASH_STDOUT,
  BASH_STDERR,
  LOCAL_COMMAND_CAVEAT,
  LOCAL_COMMAND_STDOUT,
  SYSTEM_REMINDER,
  TICK,
  STATUS,
  SUMMARY,
  'task-id',
  'tool-use-id',
  'task-type',
  'output-file',
  'reason',
  'worktree',
  'worktreePath',
  'worktreeBranch',
  'skill-format',
  // TaskOutput envelope（下划线版，防御性 strip）
  'task_id',
  'tool_use_id',
  'task_type',
  'output_file',
  'retrieval_status',
  'exit_code'
]

export function stripKnownXmlTags(content: string): string {
  let result = content
  for (const tag of KNOWN_TAGS) {
    // 自动兼容连字符/下划线两种变体（根治 task_id 匹配不到 task-id）
    const variants = new Set([tag, tag.replace(/-/g, '_'), tag.replace(/_/g, '-')])
    for (const v of variants) {
      result = result.replace(new RegExp(`<${v}[^>]*>[\\s\\S]*?</${v}>`, 'g'), '')
      result = result.replace(new RegExp(`<${v}[^>]*\\/>`, 'g'), '')
    }
  }
  return result.trim()
}

// ── ANSI 转义清理 ──

/**
 * 剥离 ANSI 转义序列，返回纯文本。
 * 兼容两种形态：
 *  1. 标准 CSI 序列（含 ESC）：如 `\x1b[1m`、`\x1b[0;32m`、`\x1b[2K`
 *  2. 传输中丢失 ESC 的 SGR 残留：如 `[1m`、`[22m`（slash 命令输出经 SSE/JSON 传输后常见）
 */
export function stripAnsi(text: string): string {
  return (
    text
      // eslint-disable-next-line no-control-regex -- ANSI ESC 序列必需的控制字符
      .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
      .replace(/\[[0-9;]*m/g, '')
  )
}
