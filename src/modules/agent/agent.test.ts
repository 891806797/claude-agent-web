import { describe, expect, test } from 'bun:test'
import { type TranslateHandlers, translateSessionStream } from './agent-event-translator'
import { _encodeCwdForTest as encodeCwd, transcriptHasUserMessage } from './agent-session-history'
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

  test('normalizeDir 归一：win32 正斜杠 + 小写；POSIX 保留大小写', () => {
    if (process.platform === 'win32') {
      expect(normalizeDir('D:/Worker\\Demo')).toBe(normalizeDir('d:\\worker\\demo'))
    } else {
      // POSIX 文件系统大小写敏感：resolve 保留原样，不得小写化/改分隔符
      expect(normalizeDir('/Home/Worker')).toBe('/Home/Worker')
    }
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

  test('needsApproval：按 runMode 分档（safe 命令+写+问卷；standard 仅问卷；auto/plan 无）', () => {
    // safe：命令 + 文件写 + 问卷
    expect(needsApproval('Bash', 'safe')).toBe(true)
    expect(needsApproval('PowerShell', 'safe')).toBe(true)
    expect(needsApproval('AskUserQuestion', 'safe')).toBe(true)
    expect(needsApproval('Edit', 'safe')).toBe(true)
    expect(needsApproval('Write', 'safe')).toBe(true)
    expect(needsApproval('NotebookEdit', 'safe')).toBe(true)
    expect(needsApproval('Read', 'safe')).toBe(false)
    // standard：仅问卷
    expect(needsApproval('Bash', 'standard')).toBe(false)
    expect(needsApproval('Edit', 'standard')).toBe(false)
    expect(needsApproval('AskUserQuestion', 'standard')).toBe(true)
    // auto / plan：无（auto 的 AskUserQuestion 由 canUseTool 直接 deny）
    expect(needsApproval('Bash', 'auto')).toBe(false)
    expect(needsApproval('AskUserQuestion', 'auto')).toBe(false)
    expect(needsApproval('Bash', 'plan')).toBe(false)
    expect(needsApproval('AskUserQuestion', 'plan')).toBe(false)
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

// ===== agent-session-history（转录内容判定）=====

describe('transcriptHasUserMessage', () => {
  test('仅 custom-title 占位 -> false（空会话，须降级为新会话）', () => {
    expect(
      transcriptHasUserMessage(
        `${JSON.stringify({
          type: 'custom-title',
          customTitle: '新会话',
          sessionId: 's1',
          uuid: 'u1',
          timestamp: '2026-08-29T00:00:00.000Z',
        })}\n`,
      ),
    ).toBe(false)
  })

  test('残留 queue-operation（无 user 条目）-> false', () => {
    const lines = [
      '{"type":"queue-operation","operation":"enqueue","content":"你好"}',
      '{"type":"queue-operation","operation":"dequeue"}',
    ]
    expect(transcriptHasUserMessage(lines.join('\n'))).toBe(false)
  })

  test('含 user 消息条目 -> true（占位 + 真实消息混合）', () => {
    const lines = [
      '{"type":"custom-title","customTitle":"新会话","sessionId":"s1"}',
      '{"parentUuid":null,"type":"user","message":{"role":"user","content":"你好"}}',
    ]
    expect(transcriptHasUserMessage(lines.join('\n'))).toBe(true)
  })

  test('空文本/不存在文件场景 -> false', () => {
    expect(transcriptHasUserMessage('')).toBe(false)
  })
})

// ===== encodeCwd：复刻 SDK om(cwd) 200 截断+hash =====

describe('encodeCwd (SDK om 复刻)', () => {
  test('短路径：仅替换非字母数字为 -，不截断', () => {
    expect(encodeCwd('D:/worker/proj')).toBe('D--worker-proj')
    expect(encodeCwd('C:\\Users\\me')).toBe('C--Users-me')
    expect(encodeCwd('/home/me/x')).toBe('-home-me-x')
  })

  test('编码后 ≤200 字符：原样返回（含恰好 200）', () => {
    const exact200 = 'a'.repeat(200)
    expect(encodeCwd(exact200)).toBe(exact200)
    expect(encodeCwd(exact200).length).toBe(200)
  })

  test('编码后 >200 字符：截断前 200 + - + hash(cwd).toString(36)', () => {
    const cwd = 'p'.repeat(217) // 编码长度 217 > 200
    const got = encodeCwd(cwd)
    expect(got.length).toBeLessThan(217)
    expect(got.startsWith(`${'p'.repeat(200)}-`)).toBe(true)
    // hash 段 = Math.abs(Java hashCode(cwd)).toString(36)，非空且全 base36
    const hashSeg = got.slice(201)
    expect(hashSeg.length).toBeGreaterThan(0)
    expect(/^[0-9a-z]+$/.test(hashSeg)).toBe(true)
  })

  test('hash 输入是原始 cwd 而非编码后：不同原 cwd 同编码会产生不同 hash', () => {
    // 两个不同 cwd，编码后都超 200 且前 200 字符相同（仅尾部不同被截断）
    const base = 'a'.repeat(210)
    const a = `${base}X`
    const b = `${base}Y`
    expect(encodeCwd(a)).not.toBe(encodeCwd(b))
  })

  test('确定性：同一 cwd 多次调用结果一致', () => {
    const cwd = `D:/very/${'deep'.repeat(60)}`
    expect(encodeCwd(cwd)).toBe(encodeCwd(cwd))
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

/**
 * 构造 SDK 流替身：yield 完 messages 后抛 err（模拟 0.3.269 is_error result 后
 * "Claude Code returned an error result" 抛异常行为）。
 */
function makeThrowingStream(messages: unknown[], err: unknown): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0
      return {
        next: () => {
          if (i < messages.length) return Promise.resolve({ done: false, value: messages[i++] })
          return Promise.reject(err)
        },
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

  test('message_start 包装层 ttft_ms → SSE message_start 携带 ttftMs', async () => {
    const { events } = await runTranslator([
      { type: 'stream_event', event: { type: 'message_start' }, ttft_ms: 1200 } as unknown as never,
      { type: 'stream_event', event: { type: 'message_stop' } },
      { type: 'result', usage: {} },
    ])
    const ms = events.find((e) => e.event === 'message_start')
    expect(ms).toBeDefined()
    expect((ms!.data as { ttftMs?: number }).ttftMs).toBe(1200)
  })

  test('message_start 无 ttft_ms → SSE message_start 不带 ttftMs 字段', async () => {
    const { events } = await runTranslator([
      { type: 'stream_event', event: { type: 'message_start' } },
      { type: 'stream_event', event: { type: 'message_stop' } },
      { type: 'result', usage: {} },
    ])
    const ms = events.find((e) => e.event === 'message_start')
    expect((ms!.data as { ttftMs?: number }).ttftMs).toBeUndefined()
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

  test('is_error result → 广播 error 事件（错误文本取 result 字段），先于 turn_end', async () => {
    const { events } = await runTranslator([
      { type: 'result', is_error: true, result: 'API Error: 403 invalid api-key', usage: {} },
    ])
    const errorIdx = events.findIndex((e) => e.event === 'error')
    const turnEndIdx = events.findIndex((e) => e.event === 'turn_end')
    expect(errorIdx).toBeGreaterThanOrEqual(0)
    expect((events[errorIdx]!.data as { message?: string }).message).toBe(
      'API Error: 403 invalid api-key',
    )
    // error 必须先于 turn_end：前端 turn_end 会把 status 重置 idle，靠 error 的 system 消息留存提示
    expect(turnEndIdx).toBeGreaterThan(errorIdx)
  })

  test('is_error result 无 result 文本 → error 事件兜底文案', async () => {
    const { events } = await runTranslator([{ type: 'result', is_error: true, usage: {} }])
    const err = events.find((e) => e.event === 'error')
    expect((err!.data as { message?: string }).message).toBe('本轮执行失败')
  })

  test('error_max_turns subtype → 错误文本取 errors[] 而非 result', async () => {
    const { events } = await runTranslator([
      {
        type: 'result',
        subtype: 'error_max_turns',
        is_error: true,
        errors: ['Reached maximum number of turns (1)'],
        usage: {},
      },
    ])
    const err = events.find((e) => e.event === 'error')
    expect((err!.data as { message?: string }).message).toBe('Reached maximum number of turns (1)')
  })

  // ===== SDK 0.3.269：is_error result 后流抛 "Claude Code returned an error result" =====

  /**
   * 自定义流 runner：喂入指定流，捕获是否 reject + onStreamEnd 调用次数 +
   * 事件列表。模拟 registry：reject 时由调用方判定是否重复广播 error。
   */
  async function runTranslatorRaw(
    stream: AsyncIterable<unknown>,
  ): Promise<{ events: SSEEvent[]; rejected: false | string; streamEnds: number }> {
    const events: SSEEvent[] = []
    let streamEnds = 0
    const handlers: TranslateHandlers = {
      onEvent: (ev) => events.push(ev),
      onSessionId: () => {},
      onStreamEnd: () => {
        streamEnds++
      },
      abortController: new AbortController(),
      sessionLogger: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
        child: () => ({}) as never,
      } as never,
    }
    let rejected: false | string = false
    try {
      await translateSessionStream(stream, handlers)
    } catch (err) {
      rejected = err instanceof Error ? err.message : String(err)
    }
    return { events, rejected, streamEnds }
  }

  test('is_error result 后 SDK 抛异常 → translator 吞掉、不 reject、仅一次 error 事件', async () => {
    const sdkErr = new Error(
      'Claude Code returned an error result: Reached maximum number of turns (1)',
    )
    const { events, rejected, streamEnds } = await runTranslatorRaw(
      makeThrowingStream(
        [
          {
            type: 'result',
            is_error: true,
            result: 'Reached maximum number of turns (1)',
            usage: {},
          },
        ],
        sdkErr,
      ),
    )
    // 关键：translator 不上抛（registry .catch 不会再广播第二次 error）
    expect(rejected).toBe(false)
    // onStreamEnd 仍触发一次（finally 收尾）
    expect(streamEnds).toBe(1)
    // 恰好一个 error 事件（result 分支那次；throw 被吞，registry 不再补刀）
    const errorEvents = events.filter((e) => e.event === 'error')
    expect(errorEvents.length).toBe(1)
    expect((errorEvents[0]!.data as { message?: string }).message).toBe(
      'Reached maximum number of turns (1)',
    )
  })

  test('无 result 的进程/连接错误 → translator 上抛由 registry 广播（不吞）', async () => {
    const crashErr = new Error('CLI process exited unexpectedly')
    const { events, rejected, streamEnds } = await runTranslatorRaw(
      makeThrowingStream([{ type: 'stream_event', event: { type: 'message_start' } }], crashErr),
    )
    // 无 is_error result → 不吞，上抛
    expect(rejected).toBe('CLI process exited unexpectedly')
    expect(streamEnds).toBe(1)
    // translator 自身不广播 error（交给 registry .catch）；这里只验未吞
    expect(events.filter((e) => e.event === 'error').length).toBe(0)
  })

  test('is_error 后又开新轮 message_start → 标记清零，后续真错误不再被吞', async () => {
    const sdkErr = new Error('CLI process exited unexpectedly')
    const { events, rejected } = await runTranslatorRaw(
      makeThrowingStream(
        [
          { type: 'result', is_error: true, result: '本轮 API 4xx', usage: {} },
          { type: 'stream_event', event: { type: 'message_start' } },
        ],
        sdkErr,
      ),
    )
    // 第一轮 is_error 已广播，但新轮 message_start 清零标记 → 后续真错误上抛
    expect(rejected).toBe('CLI process exited unexpectedly')
    // 仍保留第一轮的 error 事件
    expect(events.filter((e) => e.event === 'error').length).toBe(1)
  })

  // ===== 子代理上下文路由（forwardSubagentText 透传）=====
  // 子代理内容以带 parent_tool_use_id 的完整 assistant/user 消息送达，
  // 必须翻成 subagent_context 事件归桶，不得进主线程（不泄漏 text_chunk/tool_result）。

  test('assistant 带 parent_tool_use_id（thinking+text）→ subagent_context，不进主线程', async () => {
    const { events } = await runTranslator([
      {
        type: 'assistant',
        uuid: 'sub-msg-1',
        session_id: 'sid',
        parent_tool_use_id: 'toolu_PARENT',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: '审查认证模块…' },
            { type: 'text', text: '发现 3 处问题' },
          ],
        },
      },
      { type: 'result', usage: {} },
    ])
    const ctx = events.filter((e) => e.event === 'subagent_context')
    expect(ctx.length).toBe(2)
    expect((ctx[0]!.data as { kind: string }).kind).toBe('thinking')
    expect((ctx[0]!.data as { text: string }).text).toBe('审查认证模块…')
    expect((ctx[0]!.data as { parentToolUseId: string }).parentToolUseId).toBe('toolu_PARENT')
    expect((ctx[1]!.data as { kind: string }).kind).toBe('text')
    // 不泄漏进主线程
    expect(events.some((e) => e.event === 'message_start')).toBe(false)
    expect(events.some((e) => e.event === 'text_chunk')).toBe(false)
    expect(events.some((e) => e.event === 'thinking_chunk')).toBe(false)
  })

  test('assistant 带 parent_tool_use_id（tool_use）→ subagent_context kind=tool_use', async () => {
    const { events } = await runTranslator([
      {
        type: 'assistant',
        uuid: 'sub-msg-2',
        session_id: 'sid',
        parent_tool_use_id: 'toolu_PARENT',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tu_sub1', name: 'Read', input: { file_path: '/a' } }],
        },
      },
      { type: 'result', usage: {} },
    ])
    const ctx = events.filter((e) => e.event === 'subagent_context')
    expect(ctx.length).toBe(1)
    const d = ctx[0]!.data as {
      kind: string
      toolCallId: string
      name: string
      input: unknown
    }
    expect(d.kind).toBe('tool_use')
    expect(d.toolCallId).toBe('tu_sub1')
    expect(d.name).toBe('Read')
    expect(d.input).toEqual({ file_path: '/a' })
    // 不冒泡主线程 tool_call_*
    expect(events.some((e) => e.event === 'tool_call_start')).toBe(false)
  })

  test('user 带 parent_tool_use_id（tool_result）→ subagent_context，不进主线程 tool_result', async () => {
    const { events } = await runTranslator([
      {
        type: 'user',
        uuid: 'sub-result-1',
        session_id: 'sid',
        parent_tool_use_id: 'toolu_PARENT',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tu_sub1', content: 'file body here' }],
        },
      },
      { type: 'result', usage: {} },
    ])
    const ctx = events.filter((e) => e.event === 'subagent_context')
    expect(ctx.length).toBe(1)
    const d = ctx[0]!.data as { kind: string; toolCallId: string; content: string }
    expect(d.kind).toBe('tool_result')
    expect(d.toolCallId).toBe('tu_sub1')
    expect(d.content).toBe('file body here')
    // 关键：不泄漏成主线程 tool_result 卡片
    expect(events.some((e) => e.event === 'tool_result')).toBe(false)
  })

  test('user parent=null（主会话 tool_result）→ 主线程 tool_result 事件（回归保护）', async () => {
    const { events } = await runTranslator([
      {
        type: 'user',
        uuid: 'main-result-1',
        session_id: 'sid',
        parent_tool_use_id: null,
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tu_main', content: 'ok' }],
        },
      },
      { type: 'result', usage: {} },
    ])
    expect(events.some((e) => e.event === 'tool_result')).toBe(true)
    expect(events.some((e) => e.event === 'subagent_context')).toBe(false)
  })

  test('stream_event delta（parent=null）→ 主线程流式（回归保护，不受子代理路由影响）', async () => {
    const { events } = await runTranslator([
      { type: 'stream_event', event: { type: 'message_start' }, parent_tool_use_id: null },
      {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } },
        parent_tool_use_id: null,
      },
      { type: 'stream_event', event: { type: 'message_stop' }, parent_tool_use_id: null },
      { type: 'result', usage: {} },
    ])
    expect(events.some((e) => e.event === 'message_start')).toBe(true)
    expect(events.some((e) => e.event === 'text_chunk')).toBe(true)
    expect(events.some((e) => e.event === 'subagent_context')).toBe(false)
  })
})
