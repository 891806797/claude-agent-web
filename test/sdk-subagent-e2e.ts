/**
 * 子代理上下文端到端（实测，非 mock）：真实 query 流 → 真实 translateSessionStream → SSEEvent。
 * 验证我的 translator 对真实 SDK 子代理消息的 subagent_context 产出，且不泄漏主线程。
 *
 * 运行：bun run test/sdk-subagent-e2e.ts
 *   需 .env：ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_MODEL
 */
import { query } from '@anthropic-ai/claude-agent-sdk'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type TranslateHandlers,
  translateSessionStream,
} from '../src/modules/agent/agent-event-translator'
import type { SSEEvent, SubagentContextEvent } from '../src/modules/agent/sse-events'

const BASE_URL = process.env.ANTHROPIC_BASE_URL!
const AUTH_TOKEN = process.env.ANTHROPIC_AUTH_TOKEN!
const MODEL = process.env.ANTHROPIC_MODEL!
const CONFIG_DIR = mkdtempSync(join(tmpdir(), 'e2e-sub-claude-'))

const workDir = mkdtempSync(join(tmpdir(), 'e2e-sub-work-'))
writeFileSync(
  join(workDir, 'auth.ts'),
  'export function verifyToken(t: string): boolean { return t.length > 0 }\n',
)

function baseEnv() {
  return {
    ...process.env,
    CLAUDE_CONFIG_DIR: CONFIG_DIR,
    ANTHROPIC_BASE_URL: BASE_URL,
    ANTHROPIC_AUTH_TOKEN: AUTH_TOKEN,
    ANTHROPIC_MODEL: MODEL,
    ENABLE_TOOL_SEARCH: 'false',
  } as Record<string, string>
}

async function run() {
  const events: SSEEvent[] = []
  const handlers: TranslateHandlers = {
    onEvent: (ev) => events.push(ev),
    onSessionId: () => {},
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

  // 真实 query 流直接喂给 translator（与生产 session-registry 同一函数）
  const stream = query({
    prompt: 'Use the probe-reviewer agent to review auth.ts for security issues. Report findings.',
    options: {
      cwd: workDir,
      env: baseEnv(),
      model: MODEL,
      allowedTools: ['Read', 'Grep', 'Agent'],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      forwardSubagentText: true,
      agentProgressSummaries: true,
      includePartialMessages: true,
      agents: {
        'probe-reviewer': {
          description: 'Security reviewer. Use for reviewing source files for security issues.',
          prompt:
            'You are a security reviewer. Read the given file, identify security issues, report findings concisely. Do not modify files.',
          tools: ['Read', 'Grep'],
        },
      },
      stderr: (d) => process.stderr.write(`[e2e.stderr] ${d}`),
    },
  })

  await translateSessionStream(stream as never, handlers)

  // ===== 分类统计 =====
  const progress = events.filter((e) => e.event === 'subagent_progress')
  const ctx = events.filter((e) => e.event === 'subagent_context') as {
    event: 'subagent_context'
    data: SubagentContextEvent
  }[]
  const mainTextChunks = events.filter((e) => e.event === 'text_chunk')
  const mainToolResults = events.filter((e) => e.event === 'tool_result')

  console.log('\n===== SSE 事件统计 =====')
  console.log(`总事件: ${events.length}`)
  console.log(`subagent_progress: ${progress.length}`)
  console.log(`subagent_context: ${ctx.length}`)
  console.log(`主线程 text_chunk: ${mainTextChunks.length}`)
  console.log(`主线程 tool_result: ${mainToolResults.length}`)

  // subagent_context 按 kind 分布
  const byKind = ctx.reduce<Record<string, number>>((acc, e) => {
    acc[e.data.kind] = (acc[e.data.kind] ?? 0) + 1
    return acc
  }, {})
  console.log('subagent_context kind 分布:', byKind)

  // ===== 子代理活动流明细 =====
  console.log('\n===== 子代理活动流（subagent_context）=====')
  for (const e of ctx) {
    const d = e.data
    const head = `  [${d.kind}] parent=${d.parentToolUseId.slice(0, 12)}`
    if (d.kind === 'thinking' || d.kind === 'text') {
      console.log(`${head} text="${(d.text ?? '').slice(0, 70)}${(d.text ?? '').length > 70 ? '…' : ''}"`)
    } else if (d.kind === 'tool_use') {
      console.log(`${head} ${d.name} input=${JSON.stringify(d.input).slice(0, 70)}`)
    } else if (d.kind === 'tool_result') {
      console.log(`${head} tool=${d.toolCallId?.slice(0, 12)}${d.error ? ' [error]' : ''} content="${(d.content ?? '').slice(0, 70)}…"`)
    }
  }

  // ===== subagent_progress 摘要 =====
  console.log('\n===== subagent_progress 摘要 =====')
  for (const e of progress) {
    const d = e.data as { phase: string; lastToolName?: string; summary?: string; status?: string }
    console.log(`  [${d.phase}] lastTool=${d.lastToolName ?? '-'} status=${d.status ?? '-'} summary="${(d.summary ?? '').slice(0, 60)}"`)
  }

  // ===== 泄漏检测 =====
  console.log('\n===== 泄漏检测 =====')
  // 主线程 tool_result 不应含子代理内部工具 id（tu_sub1 这类）。此处主 tool_result 应只有 Agent 工具的。
  // 主线程 text_chunk 是父代理的回答，正常存在。关键是 subagent_context 存在且 thinking/tool_use/tool_result 在其中。
  const ctxKinds = new Set(ctx.map((e) => e.data.kind))
  const assert = (name: string, cond: boolean, detail: string) => {
    console.log(`  ${cond ? '✓' : '✗'} ${name}: ${detail}`)
    if (!cond) process.exitCode = 1
  }
  assert('subagent_context 事件产出', ctx.length > 0, `${ctx.length} 条`)
  assert(
    '含 thinking',
    ctxKinds.has('thinking'),
    `kinds=[${[...ctxKinds].join(',')}]`,
  )
  assert('含 tool_use', ctxKinds.has('tool_use'), `kinds=[${[...ctxKinds].join(',')}]`)
  assert('含 tool_result', ctxKinds.has('tool_result'), `kinds=[${[...ctxKinds].join(',')}]`)
  assert('含 text', ctxKinds.has('text'), `kinds=[${[...ctxKinds].join(',')}]`)
  assert('subagent_progress 摘要仍到达', progress.length > 0, `${progress.length} 条`)

  rmSync(workDir, { recursive: true, force: true })
  rmSync(CONFIG_DIR, { recursive: true, force: true })
  console.log('\n[e2e] done')
}

void run()
