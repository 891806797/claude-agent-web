import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  deleteSession,
  getSessionMessages,
  listSessions,
  renameSession,
  type SessionMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type { ChatMessage, ContentBlock, SanitizedSession } from './sse-events'
import { userConfigDir, withUserConfigDir } from './user-config'

/**
 * 会话历史访问层：包装 SDK 进程级历史函数（listSessions/getSessionMessages/
 * deleteSession/renameSession），经 withUserConfigDir 串行切换 CLAUDE_CONFIG_DIR——
 * 多用户并发安全（SDK 历史函数读 process.env，见 user-config.ts 说明）。
 * restoreChatMessages/coalesceAssistantBlocks 移植自 desktop sessions.ts（单遍内联改造）：
 * 流式累积与历史恢复落到同一 ChatMessage 结构，前端渲染同一条代码路径。
 */

export function listUserSessions(
  username: string,
  dir: string,
  page: { limit: number; offset: number },
): Promise<SanitizedSession[]> {
  return withUserConfigDir(username, async () => {
    const sessions = await listSessions({
      dir,
      limit: page.limit,
      offset: page.offset,
      includeWorktrees: false,
    })
    return sessions.map(sanitizeSession)
  })
}

export function getUserSessionMessages(
  username: string,
  sessionId: string,
  dir: string,
): Promise<ChatMessage[]> {
  return withUserConfigDir(username, async () => {
    // includeSystemMessages：让 compact_boundary 进入链（其 message 为 undefined，
    // 元数据由 readCompactBoundaries 直读 JSONL 按 uuid 补全）
    const msgs = await getSessionMessages(sessionId, { dir, includeSystemMessages: true })
    const boundaries = await readCompactBoundaries(username, sessionId, dir)
    const coalesced = coalesceAssistantBlocks(msgs)
    return restoreChatMessages(coalesced, boundaries)
  })
}

export function deleteUserSession(username: string, sessionId: string, dir: string): Promise<void> {
  return withUserConfigDir(username, () => deleteSession(sessionId, { dir }))
}

export function renameUserSession(
  username: string,
  sessionId: string,
  dir: string,
  title: string,
): Promise<void> {
  return withUserConfigDir(username, () => renameSession(sessionId, title, { dir }))
}

// ===== 还原逻辑（纯函数）=====

function sanitizeSession(s: {
  sessionId: string
  summary?: string
  customTitle?: string
  lastModified?: number
  gitBranch?: string
  cwd?: string
  fileSize?: number
  createdAt?: number
}): SanitizedSession {
  return {
    id: s.sessionId,
    summary: s.summary ?? '',
    title: s.customTitle ?? s.summary ?? s.sessionId.slice(0, 8),
    lastModified: s.lastModified ?? 0,
    gitBranch: s.gitBranch ?? '',
    cwd: s.cwd ?? '',
    fileSize: s.fileSize ?? 0,
    createdAt: s.createdAt ?? 0,
  }
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const texts: string[] = []
    for (const block of content) {
      if (block && typeof block === 'object') {
        const b = block as Record<string, unknown>
        if (b.type === 'text' && typeof b.text === 'string') texts.push(b.text)
      }
    }
    return texts.join('\n')
  }
  return ''
}

/** 编码 cwd 为 projects 子目录名（复刻 SDK：非字母数字一律替换为 -） */
function encodeCwd(dir: string): string {
  return dir.replace(/[^a-zA-Z0-9]/g, '-')
}

interface CompactBoundaryInfo {
  trigger: 'manual' | 'auto'
  preTokens: number
}

/** 读会话 JSONL 索引 compact_boundary 元数据（best-effort，失败返回空 Map） */
async function readCompactBoundaries(
  username: string,
  sessionId: string,
  dir: string,
): Promise<Map<string, CompactBoundaryInfo>> {
  const map = new Map<string, CompactBoundaryInfo>()
  const filePath = join(userConfigDir(username), 'projects', encodeCwd(dir), `${sessionId}.jsonl`)
  let text: string
  try {
    text = await readFile(filePath, 'utf8')
  } catch {
    return map
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let entry: Record<string, unknown>
    try {
      entry = JSON.parse(trimmed) as Record<string, unknown>
    } catch {
      continue
    }
    if (entry.type !== 'system' || entry.subtype !== 'compact_boundary') continue
    const uuid = entry.uuid
    if (typeof uuid !== 'string') continue
    const meta = (entry.compactMetadata ?? {}) as { trigger?: string; preTokens?: number }
    map.set(uuid, {
      trigger: meta.trigger === 'manual' ? 'manual' : 'auto',
      preTokens: typeof meta.preTokens === 'number' ? meta.preTokens : 0,
    })
  }
  return map
}

interface ToolResultInfo {
  content: string
  error?: boolean
  toolUseResult?: unknown
}

/**
 * 单遍还原：先索引 user 消息 content 里的 tool_result（含 tool_use_result 单数旁挂——
 * 仅该消息恰含一条 tool_result 时挂上），再逐条转换为 ChatMessage 并把结果内联到
 * assistant 的 tool_use block。流式渲染与历史回放因此共用同一数据形状。
 */
function restoreChatMessages(
  msgs: SessionMessage[],
  boundaries: Map<string, CompactBoundaryInfo>,
): ChatMessage[] {
  const resultsByToolId = new Map<string, ToolResultInfo>()
  for (const sm of msgs) {
    if (sm.type !== 'user') continue
    const wrapper = sm.message as Record<string, unknown> | undefined
    const content = wrapper?.content
    if (!Array.isArray(content)) continue
    const toolResults = content.filter((b) => (b as Record<string, unknown>).type === 'tool_result')
    const toolUseResult = (sm as { tool_use_result?: unknown }).tool_use_result
    const attachable = toolResults.length === 1 && toolUseResult !== undefined
    for (const blk of toolResults) {
      const b = blk as Record<string, unknown>
      if (typeof b.tool_use_id !== 'string') continue
      resultsByToolId.set(b.tool_use_id, {
        content: typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? ''),
        ...(b.is_error ? { error: true } : {}),
        ...(attachable ? { toolUseResult } : {}),
      })
    }
  }
  return msgs.flatMap((sm) => toChatMessage(sm, boundaries, resultsByToolId))
}

function toChatMessage(
  sm: SessionMessage,
  boundaries: Map<string, CompactBoundaryInfo>,
  resultsByToolId: Map<string, ToolResultInfo>,
): ChatMessage[] {
  if (sm.type === 'system') {
    // 仅 compact_boundary 还原为分隔符；其余 system（informational 等）丢弃
    const b = boundaries.get(sm.uuid)
    if (b) {
      return [{ type: 'compaction', id: sm.uuid, trigger: b.trigger, preTokens: b.preTokens }]
    }
    return []
  }

  const msgWrapper = sm.message as Record<string, unknown> | undefined
  const contentBlocks = msgWrapper?.content
  const contentArray = Array.isArray(contentBlocks) ? contentBlocks : []

  if (sm.type === 'user') {
    if (typeof contentBlocks === 'string') {
      return [{ type: 'user', id: sm.uuid, content: contentBlocks }]
    }
    const textBlocks = contentArray.filter(
      (b) => (b as Record<string, unknown>).type !== 'tool_result',
    )
    if (textBlocks.length === 0) return []
    return [{ type: 'user', id: sm.uuid, content: extractText(textBlocks) }]
  }

  const blocks: ContentBlock[] = []
  for (const block of contentArray) {
    const b = block as Record<string, unknown>
    if (b.type === 'text' && typeof b.text === 'string') {
      blocks.push({ type: 'text', text: b.text })
    } else if (b.type === 'thinking' && typeof b.thinking === 'string') {
      blocks.push({ type: 'thinking', text: b.thinking })
    } else if (b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') {
      const res = resultsByToolId.get(b.id)
      blocks.push({
        type: 'tool_use',
        id: b.id,
        name: b.name,
        input: (b.input ?? {}) as Record<string, unknown>,
        ...(res
          ? {
              result: res.content,
              ...(res.error ? { resultError: true } : {}),
              ...(res.toolUseResult !== undefined ? { toolUseResult: res.toolUseResult } : {}),
            }
          : {}),
      })
    }
  }
  if (blocks.length === 0) return []
  return [{ type: 'assistant', id: sm.uuid, content: blocks }]
}

/** 合并共享同一 message.id 的连续 assistant 消息（JSONL 中一个响应拆成多行） */
function coalesceAssistantBlocks(msgs: SessionMessage[]): SessionMessage[] {
  const result: SessionMessage[] = []
  let pending: SessionMessage | null = null

  for (const sm of msgs) {
    if (sm.type !== 'assistant') {
      if (pending) {
        result.push(pending)
        pending = null
      }
      result.push(sm)
      continue
    }

    const msgWrapper = sm.message as Record<string, unknown> | undefined
    const msgId = msgWrapper?.id as string | undefined

    if (pending) {
      const pendingWrapper = pending.message as Record<string, unknown> | undefined
      const pendingId = pendingWrapper?.id as string | undefined
      if (msgId && msgId === pendingId) {
        const existing = Array.isArray(pendingWrapper?.content)
          ? (pendingWrapper.content as unknown[])
          : []
        const incoming = Array.isArray(msgWrapper?.content) ? (msgWrapper.content as unknown[]) : []
        ;(pending.message as Record<string, unknown>).content = [...existing, ...incoming]
        continue
      }
      result.push(pending)
    }
    pending = structuredClone(sm)
  }

  if (pending) result.push(pending)
  return result
}
