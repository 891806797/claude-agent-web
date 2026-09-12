/**
 * SDK 0.3.269 子代理透传行为探测（实测，非 mock）。
 *
 * 探测目标（开 forwardSubagentText:true 后的真实消息形态）：
 *   S1. 子代理 text/thinking 是否以完整 assistant 消息到达？带 parent_tool_use_id？
 *   S2. partial stream_event 是否仍只属主会话（parent_tool_use_id 恒 null）？
 *   S3. tool_progress system 消息是否带 parent_tool_use_id？
 *   S4. forwardSubagentText 与 agentProgressSummaries 是否并存？task_* 摘要还到不到？
 *   S5. 顺序：父 Agent tool_use → 子代理 context 流 → Agent tool_result？
 *   S6. parent_agent_id（嵌套子代理）在本例（单层）是否恒 null？
 *
 * 运行：bun run test/sdk-subagent-behavior.ts
 *   需环境变量：ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_MODEL
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'

const BASE_URL = process.env.ANTHROPIC_BASE_URL!
const AUTH_TOKEN = process.env.ANTHROPIC_AUTH_TOKEN!
const MODEL = process.env.ANTHROPIC_MODEL!
const CONFIG_DIR = mkdtempSync(join(tmpdir(), 'probe-subagent-claude-'))

const workDir = mkdtempSync(join(tmpdir(), 'probe-subagent-work-'))
// 写一个可被只读子代理分析的小目标文件
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

interface MsgFacts {
  idx: number
  type: string
  subtype?: string
  parentToolUseId: string | null
  parentAgentId: string | null
  /** content block 类型速记，如 text/thinking/tool_use/tool_result */
  blockKinds: string[]
  /** 若是 tool_use，记 name（子代理用啥工具） */
  toolNames: string[]
  task_id?: string
  summary?: string
  last_tool_name?: string
}

function inspect(raw: SDKMessage, idx: number): MsgFacts {
  const m = raw as Record<string, unknown>
  const type = String(m.type ?? '')
  const subtype = typeof m.subtype === 'string' ? m.subtype : undefined
  const parentToolUseId = (typeof m.parent_tool_use_id === 'string' && m.parent_tool_use_id) || null
  const parentAgentId = (typeof m.parent_agent_id === 'string' && m.parent_agent_id) || null

  const blockKinds: string[] = []
  const toolNames: string[] = []
  // assistant / user 消息：挖 message.content
  const msgPayload = (m.message as { content?: unknown } | undefined)?.content
  if (Array.isArray(msgPayload)) {
    for (const b of msgPayload as Array<Record<string, unknown>>) {
      const t = typeof b.type === 'string' ? b.type : '?'
      blockKinds.push(t)
      if (t === 'tool_use' && typeof b.name === 'string') toolNames.push(b.name)
      if (t === 'tool_result') blockKinds.push('tool_result')
    }
  }
  // stream_event：event.type
  const evt = (m as { event?: Record<string, unknown> }).event
  if (evt && typeof evt.type === 'string') blockKinds.push(`stream:${evt.type}`)

  const facts: MsgFacts = {
    idx,
    type,
    subtype,
    parentToolUseId,
    parentAgentId,
    blockKinds,
    toolNames,
  }
  if (typeof m.task_id === 'string') facts.task_id = m.task_id
  if (typeof m.summary === 'string') facts.summary = m.summary
  if (typeof m.last_tool_name === 'string') facts.last_tool_name = m.last_tool_name
  return facts
}

async function run() {
  const messages: SDKMessage[] = []
  try {
    for await (const m of query({
      prompt:
        'Use the probe-reviewer agent to review auth.ts for security issues. Then report its findings.',
      options: {
        cwd: workDir,
        env: baseEnv(),
        model: MODEL,
        allowedTools: ['Read', 'Grep', 'Agent'],
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        // 关键：透传子代理 text/thinking 为完整消息（带 parent_tool_use_id）
        forwardSubagentText: true,
        // 摘要保留——探测两者是否并存
        agentProgressSummaries: true,
        includePartialMessages: false,
        agents: {
          'probe-reviewer': {
            description: 'Security reviewer. Use for reviewing source files for security issues.',
            prompt:
              'You are a security reviewer. Read the given file, identify security issues, report findings concisely. Do not modify files.',
            tools: ['Read', 'Grep'],
          },
        },
        stderr: (d) => process.stderr.write(`[subagent.stderr] ${d}`),
      },
    })) {
      messages.push(m)
    }
  } catch (e) {
    console.log('[subagent] query threw:', e instanceof Error ? e.message : e)
  }

  const facts = messages.map(inspect)

  // ===== S1/S2/S3: 按 parent_tool_use_id 分桶 =====
  const main = facts.filter((f) => f.parentToolUseId === null)
  const sub = facts.filter((f) => f.parentToolUseId !== null)
  console.log('\n===== S1/S2/S3: parent_tool_use_id 分桶 =====')
  console.log(`总消息数: ${facts.length} | 主会话(null): ${main.length} | 子代理: ${sub.length}`)
  console.log(
    '子代理消息类型分布:',
    sub.reduce<Record<string, number>>((acc, f) => {
      const key = `${f.type}${f.subtype ? `/${f.subtype}` : ''}`
      acc[key] = (acc[key] ?? 0) + 1
      return acc
    }, {}),
  )

  console.log('\n--- 子代理消息明细（前 20）---')
  for (const f of sub.slice(0, 20)) {
    console.log(
      `  #${f.idx} type=${f.type}${f.subtype ? `/${f.subtype}` : ''} ` +
        `parent=${f.parentToolUseId?.slice(0, 12)} ` +
        `blocks=[${f.blockKinds.join(',')}] tools=[${f.toolNames.join(',')}]` +
        (f.summary ? ` summary="${f.summary.slice(0, 60)}"` : '') +
        (f.last_tool_name ? ` lastTool=${f.last_tool_name}` : ''),
    )
  }

  // ===== S4: task_* 摘要是否仍到达 =====
  const taskSummaries = facts.filter((f) =>
    ['task_started', 'task_progress', 'task_notification', 'task_updated'].includes(
      f.subtype ?? '',
    ),
  )
  console.log('\n===== S4: task_* 摘要 =====')
  console.log(`task_* 消息数: ${taskSummaries.length}`)
  for (const f of taskSummaries) {
    console.log(
      `  #${f.idx} ${f.subtype} task=${f.task_id?.slice(0, 12)} ` +
        `lastTool=${f.last_tool_name ?? '-'} summary="${(f.summary ?? '').slice(0, 60)}"`,
    )
  }

  // ===== S5: 顺序 =====
  const agentToolUse = facts.find(
    (f) => f.parentToolUseId === null && f.toolNames.includes('Agent'),
  )
  const firstSub = sub[0]
  const agentResult = facts.find((f) => {
    // Agent 工具的 tool_result：主会话 user 消息含 tool_result 且紧跟子代理流之后
    const content = (f as { blockKinds: string[] }).blockKinds
    return (
      f.parentToolUseId === null && content.includes('tool_result') && f.idx > (firstSub?.idx ?? 0)
    )
  })
  console.log('\n===== S5: 顺序 =====')
  console.log(
    `父 Agent tool_use: #${agentToolUse?.idx ?? -1} | ` +
      `首条子代理消息: #${firstSub?.idx ?? -1} | ` +
      `Agent tool_result: #${agentResult?.idx ?? -1}`,
  )

  // ===== S6: parent_agent_id（单层应为 null）=====
  const nested = facts.filter((f) => f.parentAgentId !== null)
  console.log('\n===== S6: 嵌套 parent_agent_id =====')
  console.log(`parent_agent_id 非空消息数: ${nested.length}（单层应为 0）`)

  // ===== 硬断言：探针必须证实的最小契约 =====
  console.log('\n===== 断言 =====')
  const assert = (name: string, cond: boolean, detail: string) => {
    console.log(`  ${cond ? '✓' : '✗'} ${name}: ${detail}`)
    if (!cond) process.exitCode = 1
  }
  assert('S1.子代理消息到达', sub.length > 0, `${sub.length} 条带 parent_tool_use_id`)
  assert(
    'S1.子代理含 text/thinking',
    sub.some((f) => f.blockKinds.includes('text') || f.blockKinds.includes('thinking')),
    '子代理透传了 text/thinking 完整消息',
  )
  assert('S2.主会话 Agent tool_use 存在', !!agentToolUse, `idx=${agentToolUse?.idx ?? -1}`)
  assert(
    'S5.顺序 父→子→result',
    !!agentToolUse &&
      !!firstSub &&
      !!agentResult &&
      agentToolUse.idx < firstSub.idx &&
      firstSub.idx < agentResult.idx,
    `${agentToolUse?.idx} < ${firstSub?.idx} < ${agentResult?.idx}`,
  )

  // 清理
  rmSync(workDir, { recursive: true, force: true })
  rmSync(CONFIG_DIR, { recursive: true, force: true })
  console.log('\n[subagent] done')
}

void run()
