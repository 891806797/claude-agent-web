/**
 * SDK 0.3.269 行为探测（实测，非 mock）。
 * 覆盖升级关注点：
 *   A. streaming-input 下 error_max_turns 是否抛异常 + 是否先发 is_error result
 *   B. 单次 query() error_max_turns 是否抛异常
 *   C. AssistantMessage 粒度（每 content block 一个？message.id 共享？）
 *   D. StreamEvent 是否含 ttft_ms / user_message_uuid
 *   E. 全栈：真实 query → 真实 translateSessionStream → max_turns → error 事件不重复
 *
 * 运行：bun run test/sdk-behavior.ts
 */
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { translateSessionStream, type TranslateHandlers } from '../src/modules/agent/agent-event-translator'
import type { SSEEvent } from '../src/modules/agent/sse-events'
import { _encodeCwdForTest as productionEncodeCwd } from '../src/modules/agent/agent-session-history'

const BASE_URL = process.env.ANTHROPIC_BASE_URL!
const AUTH_TOKEN = process.env.ANTHROPIC_AUTH_TOKEN!
const MODEL = process.env.ANTHROPIC_MODEL!
const CONFIG_DIR = mkdtempSync(join(tmpdir(), 'probe-claude-'))

const workDir = mkdtempSync(join(tmpdir(), 'probe-work-'))
writeFileSync(join(workDir, 'target.txt'), 'hello\n')

function baseEnv() {
  return {
    ...process.env,
    CLAUDE_CONFIG_DIR: CONFIG_DIR,
    ANTHROPIC_BASE_URL: BASE_URL,
    ANTHROPIC_AUTH_TOKEN: AUTH_TOKEN,
    ANTHROPIC_MODEL: MODEL,
    // 关闭工具搜索（非一方主机默认即关，显式确保）
    ENABLE_TOOL_SEARCH: 'false',
  } as Record<string, string>
}

function log(tag: string, obj: unknown) {
  console.log(`[${tag}]`, typeof obj === 'string' ? obj : JSON.stringify(obj))
}

/** 单次 async iterable，yield 一条 user message 后结束（streaming-input 模式） */
function singleTurn(prompt: string) {
  return {
    [Symbol.asyncIterator]() {
      let done = false
      return {
        next() {
          if (done) return Promise.resolve({ value: undefined, done: true })
          done = true
          return Promise.resolve({
            value: { type: 'user', message: { role: 'user', content: prompt } },
            done: false,
          })
        },
      }
    },
  }
}

// ===== A. streaming-input error_max_turns =====
async function testA() {
  console.log('\n===== A: streaming-input error_max_turns =====')
  const messages: SDKMessage[] = []
  let threw = false
  let throwInfo: unknown = null
  let resultBeforeThrow: { subtype?: string; is_error?: boolean; errors?: string[] } | null = null
  try {
    for await (const m of query({
      prompt: singleTurn('Read target.txt, then create a file out1.txt with its contents, then create out2.txt. Must do all three.'),
      options: {
        cwd: workDir,
        env: baseEnv(),
        maxTurns: 1, // 强制 max_turns
        allowedTools: ['Read', 'Write'],
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        includePartialMessages: false,
        stderr: (d) => process.stderr.write(`[A.stderr] ${d}`),
      },
    })) {
      messages.push(m)
      log('A.msg', { type: m.type, subtype: (m as { subtype?: string }).subtype })
      if (m.type === 'result') {
        resultBeforeThrow = {
          subtype: (m as { subtype?: string }).subtype,
          is_error: (m as { is_error?: boolean }).is_error,
          errors: (m as { errors?: string[] }).errors,
        }
      }
    }
  } catch (err) {
    threw = true
    throwInfo = err instanceof Error
      ? { name: err.name, message: err.message, ctor: err.constructor.name }
      : String(err)
  }
  console.log('A.threw =', threw)
  console.log('A.throwInfo =', JSON.stringify(throwInfo))
  console.log('A.resultBeforeThrow =', JSON.stringify(resultBeforeThrow))
  console.log('A.msgTypes =', JSON.stringify(messages.map((m) => m.type)))
  // 关键判定：是否抛？抛前是否有 is_error result？
  const dup = threw && resultBeforeThrow?.is_error
  console.log('A.DUPLICATE_ERROR_RISK =', dup)
}

// ===== B. single-shot error_max_turns =====
async function testB() {
  console.log('\n===== B: single-shot error_max_turns =====')
  let threw = false
  let throwInfo: unknown = null
  let resultSeen = false
  try {
    for await (const m of query({
      prompt: 'Read target.txt, create out1.txt, then out2.txt, then out3.txt. Do all.',
      options: {
        cwd: workDir,
        env: baseEnv(),
        maxTurns: 1,
        allowedTools: ['Read', 'Write'],
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        stderr: (d) => process.stderr.write(`[B.stderr] ${d}`),
      },
    })) {
      if (m.type === 'result') {
        resultSeen = true
        log('B.result', {
          subtype: (m as { subtype?: string }).subtype,
          is_error: (m as { is_error?: boolean }).is_error,
        })
      }
    }
  } catch (err) {
    threw = true
    throwInfo = err instanceof Error
      ? { name: err.name, message: err.message, ctor: err.constructor.name }
      : String(err)
  }
  console.log('B.threw =', threw)
  console.log('B.resultSeenBeforeThrow =', resultSeen)
  console.log('B.throwInfo =', JSON.stringify(throwInfo))
}

// ===== C. AssistantMessage 粒度 =====
async function testC() {
  console.log('\n===== C: AssistantMessage granularity =====')
  const assistants: { id?: string; blocks: string[] }[] = []
  try {
    for await (const m of query({
      prompt: 'Read target.txt and tell me its contents. Use the Read tool first, then summarize in one sentence.',
      options: {
        cwd: workDir,
        env: baseEnv(),
        allowedTools: ['Read'],
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        includePartialMessages: false,
        stderr: () => {},
      },
    })) {
      if (m.type === 'assistant') {
        const a = m as { message?: { id?: string; content?: Array<{ type: string }> } }
        assistants.push({
          id: a.message?.id,
          blocks: (a.message?.content ?? []).map((b) => b.type),
        })
      }
    }
  } catch (err) {
    console.log('C.threw =', err instanceof Error ? err.message : err)
  }
  console.log('C.assistantCount =', assistants.length)
  console.log('C.assistants =', JSON.stringify(assistants, null, 2))
  // 多个 assistant message 是否共享同一 message.id？
  const ids = new Set(assistants.map((a) => a.id))
  console.log('C.distinctMessageIds =', ids.size, ids)
}

// ===== D. StreamEvent ttft_ms / user_message_uuid =====
async function testD() {
  console.log('\n===== D: StreamEvent fields (on stream_event wrapper, not event.*) =====')
  const wrappers: Array<Record<string, unknown>> = []
  try {
    for await (const m of query({
      prompt: 'Say hi in one word.',
      options: {
        cwd: workDir,
        env: baseEnv(),
        allowedTools: [],
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        includePartialMessages: true,
        stderr: () => {},
      },
    })) {
      if (m.type === 'stream_event') {
        // ttft_ms / user_message_uuid 在包装层（SDKPartialAssistantMessage），非 event 内
        wrappers.push({
          eventType: (m as { event: { type?: string } }).event.type,
          ttft_ms: (m as { ttft_ms?: unknown }).ttft_ms,
          user_message_uuid: (m as { user_message_uuid?: unknown }).user_message_uuid,
          wrapperKeys: Object.keys(m).filter((k) => k !== 'event'),
        })
      }
    }
  } catch (err) {
    console.log('D.threw =', err instanceof Error ? err.message : err)
  }
  console.log('D.streamEventTypes =', JSON.stringify(wrappers.map((w) => w.eventType)))
  const startWrapper = wrappers.find((w) => w.eventType === 'message_start')
  console.log('D.message_start wrapper =', startWrapper ? JSON.stringify(startWrapper, null, 2) : 'none')
  const ttftVal = startWrapper?.ttft_ms
  console.log('D.ttft_ms value =', ttftVal, typeof ttftVal === 'number' ? '(number ✓)' : '')
  const hasTtft = wrappers.some((w) => w.ttft_ms !== undefined)
  console.log('D.hasTtft_ms (any stream_event) =', hasTtft)
  const hasUmu = wrappers.some((w) => w.user_message_uuid !== undefined)
  console.log('D.hasUserMessageUuid =', hasUmu)
}

// ===== E. 全栈：真实 query → translateSessionStream → max_turns 不重复 error =====
async function testE() {
  console.log('\n===== E: full-stack translator + real SDK, max_turns =====')
  const events: SSEEvent[] = []
  let streamEnds = 0
  let rejected = false
  let rejectMsg = ''
  const abortController = new AbortController()
  const handlers: TranslateHandlers = {
    onEvent: (ev) => {
      events.push(ev)
    },
    onSessionId: () => {},
    onStreamEnd: () => {
      streamEnds++
    },
    abortController,
    sessionLogger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
      child: () => ({}) as never,
    } as never,
  }
  const q = query({
    prompt: singleTurn('Read target.txt, create out1.txt, then out2.txt, then out3.txt. Do all four.'),
    options: {
      cwd: workDir,
      env: baseEnv(),
      maxTurns: 1,
      allowedTools: ['Read', 'Write'],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      includePartialMessages: false,
      stderr: () => {},
    },
  })
  try {
    await translateSessionStream(q, handlers)
  } catch (err) {
    rejected = true
    rejectMsg = err instanceof Error ? err.message : String(err)
  }
  const errorEvents = events.filter((e) => e.event === 'error')
  console.log('E.rejected =', rejected, rejectMsg ? `(${rejectMsg})` : '')
  console.log('E.streamEnds =', streamEnds)
  console.log('E.errorEventCount =', errorEvents.length)
  console.log('E.errorMessages =', JSON.stringify(errorEvents.map((e) => (e.data as { message?: string }).message)))
  // 修复后：translator 吞掉 SDK 的 error-result throw，不 reject，恰好 1 个 error 事件
  const pass = !rejected && errorEvents.length === 1
  console.log('E.PASS (no dup error) =', pass)
}

// ===== F. 长路径 project dir 命名：SDK 200 字符截断+hash vs 我们的 encodeCwd =====
// SDK om(cwd): Au(cwd).replace non-alnum→'-'；len>200 → slice(0,200)+'-'+Math.abs(hashCode(cwd)).toString(36)
// hashCode = Java String.hashCode: t=(t<<5)-t+charCode|0
function sdkHashCode(s: string): number {
  let t = 0
  for (let n = 0; n < s.length; n++) t = ((t << 5) - t + s.charCodeAt(n)) | 0
  return t
}
/** 复刻 SDK om(cwd) project dir 名算法（与 sdk.mjs om/Au/Os/$je/SC 一致） */
function sdkProjectDirName(cwd: string): string {
  const enc = cwd.replace(/[^a-zA-Z0-9]/g, '-')
  if (enc.length <= 200) return enc
  return `${enc.slice(0, 200)}-${Math.abs(sdkHashCode(cwd)).toString(36)}`
}
/** 当前代码的 encodeCwd（仅替换，无截断）——复刻 agent-session-history.ts */
function currentEncodeCwd(dir: string): string {
  return dir.replace(/[^a-zA-Z0-9]/g, '-')
}

async function testF() {
  console.log('\n===== F: long-cwd project dir truncation+hash =====')
  const tmp = process.env.TEMP || tmpdir()
  // 单段 180 字符目录名 → 完整路径 >200 字符触发 SDK 截断
  const longSeg = 'p'.repeat(180)
  const longDir = join(tmp, longSeg)
  try {
    await import('node:fs/promises').then((fs) => fs.mkdir(longDir, { recursive: true }))
  } catch (e) {
    console.log('F.SKIP mkdir longDir failed:', e instanceof Error ? e.message : e)
    return
  }
  const longConfig = mkdtempSync(join(tmpdir(), 'probe-longcfg-'))
  let sdkSid = ''
  try {
    for await (const m of query({
      prompt: 'Reply with the single word: ok',
      options: {
        cwd: longDir,
        env: { ...baseEnv(), CLAUDE_CONFIG_DIR: longConfig },
        allowedTools: [],
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        stderr: () => {},
      },
    })) {
      if (m.type === 'result' && 'session_id' in m) sdkSid = (m as { session_id: string }).session_id
    }
  } catch (err) {
    console.log('F.query threw (expected for single-shot):', err instanceof Error ? err.message : err)
  }
  // 读取 SDK 实际创建的 projects 子目录名
  const projectsRoot = join(longConfig, 'projects')
  let actualDir = ''
  try {
    const entries = await import('node:fs/promises').then((fs) => fs.readdir(projectsRoot))
    actualDir = entries[0] ?? ''
  } catch {
    console.log('F.SKIP no projects dir (query may have failed before write)')
    rmSync(longDir, { recursive: true, force: true })
    rmSync(longConfig, { recursive: true, force: true })
    return
  }
  const predicted = sdkProjectDirName(longDir)
  const current = currentEncodeCwd(longDir)
  const production = productionEncodeCwd(longDir)
  console.log('F.longDir length =', longDir.length)
  console.log('F.SDK actual projects dir =', actualDir)
  console.log('F.predicted (om algorithm) =', predicted)
  console.log('F.current encodeCwd (no trunc) length =', current.length, 'matches SDK?', current === actualDir)
  console.log('F.production encodeCwd (fixed) matches SDK actual =', production === actualDir)
  console.log('F.SDK wrote session JSONL =', sdkSid ? 'yes' : 'no')
  // 关键：修复后生产 encodeCwd 应与 SDK 实际目录一致
  const pass = production === actualDir && current !== actualDir
  console.log('F.PASS (production matches SDK, old diverges) =', pass)
  rmSync(longDir, { recursive: true, force: true })
  rmSync(longConfig, { recursive: true, force: true })
}

// ===== G. 全栈：真实 query → translateSessionStream → message_start 携带 ttftMs =====
async function testG() {
  console.log('\n===== G: full-stack ttft_ms passthrough =====')
  const events: SSEEvent[] = []
  const abortController = new AbortController()
  const handlers: TranslateHandlers = {
    onEvent: (ev) => {
      events.push(ev)
    },
    onSessionId: () => {},
    onStreamEnd: () => {},
    abortController,
    sessionLogger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
      child: () => ({}) as never,
    } as never,
  }
  const q = query({
    prompt: singleTurn('Say hi in one word.'),
    options: {
      cwd: workDir,
      env: baseEnv(),
      allowedTools: [],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      includePartialMessages: true,
      stderr: () => {},
    },
  })
  try {
    await translateSessionStream(q, handlers)
  } catch {
    /* single-shot/streaming end */
  }
  const ms = events.find((e) => e.event === 'message_start')
  const ttft = (ms?.data as { ttftMs?: number } | undefined)?.ttftMs
  console.log('G.message_start present =', !!ms)
  console.log('G.ttftMs =', ttft, typeof ttft === 'number' ? '(number ✓)' : '')
  console.log('G.PASS (ttftMs number passed through) =', typeof ttft === 'number')
}

async function main() {
  console.log('CONFIG_DIR =', CONFIG_DIR)
  console.log('workDir =', workDir)
  console.log('model =', MODEL, 'base =', BASE_URL)
  try {
    await testA()
  } catch (e) {
    console.log('A.FATAL', e instanceof Error ? e.message : e)
  }
  try {
    await testB()
  } catch (e) {
    console.log('B.FATAL', e instanceof Error ? e.message : e)
  }
  try {
    await testC()
  } catch (e) {
    console.log('C.FATAL', e instanceof Error ? e.message : e)
  }
  try {
    await testD()
  } catch (e) {
    console.log('D.FATAL', e instanceof Error ? e.message : e)
  }
  try {
    await testE()
  } catch (e) {
    console.log('E.FATAL', e instanceof Error ? e.message : e)
  }
  try {
    await testF()
  } catch (e) {
    console.log('F.FATAL', e instanceof Error ? e.message : e)
  }
  try {
    await testG()
  } catch (e) {
    console.log('G.FATAL', e instanceof Error ? e.message : e)
  }
  // 清理
  rmSync(workDir, { recursive: true, force: true })
  rmSync(CONFIG_DIR, { recursive: true, force: true })
  console.log('\n===== done =====')
}

main().catch((e) => {
  console.error('probe crashed', e)
  process.exit(1)
})
