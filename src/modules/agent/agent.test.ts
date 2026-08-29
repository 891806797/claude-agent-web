import { describe, expect, test } from 'bun:test'
import { type TranslateHandlers, translateSessionStream } from './agent-event-translator'
import {
  APPROVAL_TIMEOUT_MS,
  type ApprovalDecision,
  ApprovalManager,
  needsApproval,
} from './approval-manager'
import { decodeDir, encodeDir, normalizeDir } from './paths'
import type { SSEEvent } from './sse-events'

/**
 * agent 模块纯单测 —— 不依赖数据库与 SDK 子进程（确定性、快）。
 * 覆盖：paths 编解码、approval-manager 作答/总是允许/关闭清空/重放、
 * translator 流式块→SSEEvent 翻译（message_start/text_chunk/message_end/turn_end + tool_result）。
 */

// ===== paths =====

describe('paths', () => {
  test('encodeDir/decodeDir base64url 往返（含中文与反斜杠）', () => {
    const dir = 'D:\\worker\\项目\\demo path'
    const enc = encodeDir(dir)
    expect(enc).toMatch(/^[A-Za-z0-9_-]+$/) // base64url 字符集，无 = 填充
    expect(decodeDir(enc)).toBe(dir)
  })

  test('normalizeDir 归一：正斜杠 + 小写', () => {
    expect(normalizeDir('D:/Worker\\Demo')).toBe(normalizeDir('d:\\worker\\demo'))
  })
})

// ===== approval-manager =====

describe('ApprovalManager', () => {
  function makeManager() {
    const settled: Array<{ id: string; outcome: string; reason?: string }> = []
    const sessionSignal = new AbortController().signal
    const mgr = new ApprovalManager(sessionSignal, (id, outcome, reason) =>
      settled.push({ id, outcome, ...(reason ? { reason } : {}) }),
    )
    return { mgr, settled, sessionSignal }
  }

  test('needsApproval：仅 Bash/PowerShell/AskUserQuestion', () => {
    expect(needsApproval('Bash')).toBe(true)
    expect(needsApproval('PowerShell')).toBe(true)
    expect(needsApproval('AskUserQuestion')).toBe(true)
    expect(needsApproval('Read')).toBe(false)
    expect(needsApproval('Edit')).toBe(false)
    expect(needsApproval('Write')).toBe(false)
  })

  test('resolve allow → onSettled(allow)', async () => {
    const { mgr, settled } = makeManager()
    const sig = new AbortController().signal
    const p = mgr.request({
      toolCallId: 't1',
      toolName: 'Bash',
      input: { command: 'ls' },
      signal: sig,
    })
    mgr.resolve('t1', { allowed: true })
    const dec: ApprovalDecision = await p
    expect(dec.allowed).toBe(true)
    expect(settled).toEqual([{ id: 't1', outcome: 'allow' }])
  })

  test('resolve deny + feedback → onSettled(deny, reason)', async () => {
    const { mgr, settled } = makeManager()
    const sig = new AbortController().signal
    const p = mgr.request({
      toolCallId: 't2',
      toolName: 'Bash',
      input: { command: 'rm -rf' },
      signal: sig,
    })
    mgr.resolve('t2', { allowed: false, feedback: '危险命令' })
    const dec = await p
    expect(dec.allowed).toBe(false)
    expect(dec.feedback).toBe('危险命令')
    expect(settled).toEqual([{ id: 't2', outcome: 'deny', reason: '危险命令' }])
  })

  test('alwaysAllow：同工具再次请求直接放行（无 onSettled）', async () => {
    const { mgr, settled } = makeManager()
    const sig = new AbortController().signal
    const p1 = mgr.request({
      toolCallId: 'a1',
      toolName: 'PowerShell',
      input: { command: 'dir' },
      signal: sig,
    })
    mgr.resolve('a1', { allowed: true, alwaysAllow: true })
    await p1
    expect(settled.length).toBe(1) // 仅首次产生 settled

    const p2 = mgr.request({
      toolCallId: 'a2',
      toolName: 'PowerShell',
      input: { command: 'dir' },
      signal: sig,
    })
    const dec = await p2
    expect(dec.allowed).toBe(true)
    expect(settled.length).toBe(1) // 总是允许走快路，不再挂起/不触发 onSettled
  })

  test('closeAll：清空挂起 → onSettled(closed)', async () => {
    const { mgr, settled } = makeManager()
    const sig = new AbortController().signal
    const p = mgr.request({
      toolCallId: 'c1',
      toolName: 'Bash',
      input: { command: 'ls' },
      signal: sig,
    })
    mgr.closeAll()
    const dec = await p
    expect(dec.allowed).toBe(false)
    expect(settled).toEqual([{ id: 'c1', outcome: 'closed', reason: '会话已关闭' }])
    expect(mgr.getPending().length).toBe(0)
  })

  test('getPending：未决时暴露 expiresAt', () => {
    const { mgr } = makeManager()
    const sig = new AbortController().signal
    mgr.request({ toolCallId: 'p1', toolName: 'Bash', input: { command: 'ls' }, signal: sig })
    const pending = mgr.getPending()
    expect(pending.length).toBe(1)
    expect(pending[0]!.toolCallId).toBe('p1')
    expect(pending[0]!.expiresAt).toBeGreaterThan(Date.now())
    expect(pending[0]!.expiresAt - Date.now()).toBeLessThanOrEqual(APPROVAL_TIMEOUT_MS)
  })

  test('resolve 不存在的 toolCallId → false（已处理/超时）', () => {
    const { mgr } = makeManager()
    expect(mgr.resolve('nonexistent', { allowed: true })).toBe(false)
  })
})

// ===== agent-event-translator =====

/** 构造一次性 AsyncIterable（SDK 流替身） */
function makeStream(messages: unknown[]): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0
      return {
        next: () =>
          Promise.resolve(
            i < messages.length
              ? { done: false, value: messages[i++] }
              : { done: true, value: undefined },
          ),
      }
    },
  }
}

async function runTranslator(
  messages: unknown[],
): Promise<{ events: SSEEvent[]; sessionIds: string[] }> {
  const events: SSEEvent[] = []
  const sessionIds: string[] = []
  const handlers: TranslateHandlers = {
    onEvent: (ev) => events.push(ev),
    onSessionId: (sid) => sessionIds.push(sid),
    onStreamEnd: () => {},
    abortController: new AbortController(),
    sessionLogger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
      child: () => ({}) as never,
    } as never,
  }
  await translateSessionStream(makeStream(messages), handlers)
  return { events, sessionIds }
}

describe('translateSessionStream', () => {
  test('system init → onSessionId + session 事件', async () => {
    const { sessionIds, events } = await runTranslator([
      { type: 'system', subtype: 'init', session_id: 'sid-123' },
    ])
    expect(sessionIds).toEqual(['sid-123'])
    expect(events.some((e) => e.event === 'session' && e.data.sessionId === 'sid-123')).toBe(true)
  })

  test('assistant 文本流 → message_start/text_chunk/message_end/turn_end', async () => {
    const { events } = await runTranslator([
      { type: 'stream_event', event: { type: 'message_start' } },
      {
        type: 'stream_event',
        event: { type: 'content_block_start', content_block: { type: 'text' } },
      },
      {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } },
      },
      {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo' } },
      },
      {
        type: 'stream_event',
        event: { type: 'content_block_stop', content_block: { type: 'text' } },
      },
      { type: 'stream_event', event: { type: 'message_stop' } },
      {
        type: 'result',
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    ])
    const types = events.map((e) => e.event)
    expect(types).toContain('message_start')
    const textChunks = events.filter((e) => e.event === 'text_chunk')
    expect(textChunks.length).toBe(2)
    expect(types).toContain('message_end')
    expect(types).toContain('usage')
    expect(types).toContain('turn_end')
  })

  test('user tool_result → tool_result 事件（含 toolUseResult 单数旁挂）', async () => {
    const { events } = await runTranslator([
      {
        type: 'user',
        uuid: 'u1',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tc1', content: 'done' }] },
        tool_use_result: { ok: true },
      },
    ])
    const tr = events.find((e) => e.event === 'tool_result')
    expect(tr).toBeDefined()
    expect((tr!.data as { toolCallId: string }).toolCallId).toBe('tc1')
    expect((tr!.data as { toolUseResult?: unknown }).toolUseResult).toEqual({ ok: true })
    // 同时产 checkpoint
    expect(events.some((e) => e.event === 'checkpoint')).toBe(true)
  })

  test('tool_use 流式块 → tool_call_start/args/end', async () => {
    const { events } = await runTranslator([
      { type: 'stream_event', event: { type: 'message_start' } },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: { type: 'tool_use', id: 'tu1', name: 'Bash' },
        },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'input_json_delta', partial_json: '{"command":"ls' },
        },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'input_json_delta', partial_json: '"}' },
        },
      },
      {
        type: 'stream_event',
        event: { type: 'content_block_stop', content_block: { type: 'tool_use' } },
      },
      { type: 'stream_event', event: { type: 'message_stop' } },
      { type: 'result', usage: {} },
    ])
    const types = events.map((e) => e.event)
    expect(types).toContain('tool_call_start')
    expect(types).toContain('tool_call_args')
    expect(types).toContain('tool_call_end')
  })
})
