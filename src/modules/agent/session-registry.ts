import { type Query, query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { Logger } from 'pino'
import { AppError } from '@/core/app-error'
import { getLogger } from '@/core/logger'
import { db } from '@/db'
import { env } from '@/env'
import { agentRepository } from './agent.repository'
import type { OccupiedInfoData } from './agent.schema'
import { translateSessionStream } from './agent-event-translator'
import { buildSessionQueryOptions, type CanUseToolFn } from './agent-query-options'
import {
  APPROVAL_TIMEOUT_MS,
  type ApprovalDecision,
  ApprovalManager,
  needsApproval,
} from './approval-manager'
import { normalizeDir } from './paths'
import { SdkInputStream } from './sdk-input-stream'
import type { SequencedEvent, SessionCloseReason, SSEEvent } from './sse-events'
import { ensureUserConfigDir } from './user-config'

/**
 * 会话注册表 —— agent 模块的运行时核心（单例内存态）。
 *
 * 存储结构：Map<normalizedDir, SessionContext>——主键即业务约束
 * （每 workspaceDir 全局唯一活跃 claude 进程，重复插入即违反唯一性）。
 *
 * 生命周期：
 * - 开启：openSession（dir 锁串行 + 配额 + evict 原子切换 + sessionId 时序）
 * - 关闭：closeSessionByDir（用户主动/idle 回收/登出/evict）+ janitor 兜底（6h 寿命）
 * - 自然退出：子进程 crash/OOM → 翻译循环退出 → finalize(process_exit)
 * - 唯一停止开关 abortController.abort()（SDK 拆除链：关 stdin → 2s 优雅 → SIGKILL）
 *
 * SSE 完整性：每事件分配单调递增 seq，RingBuffer(500) 常驻缓存，
 * 断线重连按 Last-Event-ID 增量重放；审批挂起态随 attach 重放。
 */

/** 事件缓冲容量（超出丢最旧；覆盖不到时前端走历史快照对账） */
const BUFFER_CAPACITY = 500

export type SessionState = 'starting' | 'idle' | 'turn-running' | 'closing' | 'closed'

export interface SessionContext {
  readonly username: string
  /** normalizedDir，即 Map 键 */
  readonly workspaceDir: string
  sessionId: string
  readonly createdAt: number
  lastActiveAt: number
  state: SessionState
  turns: number
  tokenUsage: { inputTokens: number; outputTokens: number }
  readonly stream: SdkInputStream
  readonly queryObj: Query
  readonly abortController: AbortController
  readonly sessionLogger: Logger
  readonly approvals: ApprovalManager
  /** SSE 订阅者（多 tab 多播）；发送失败由订阅方自清理 */
  readonly subscribers: Set<(msg: SequencedEvent) => void>
  /** 事件环形缓冲（seq 单调递增，SSE 重连重放源） */
  readonly buffer: SequencedEvent[]
  seq: number
  /** 翻译循环退出信号（closeSession await 它后再广播 query_closed） */
  readonly done: Promise<void>
  /** finalize 防重入标志（closeSession 与自然退出可能竞争） */
  finalized: boolean
}

export interface OpenSessionParams {
  username: string
  /** 已归一化的项目路径（agent_projects.path） */
  projectPath: string
  resumeSessionId?: string
  model?: string
  firstMessage?: string
  evict?: boolean
  /** 首条消息图片附件 */
  firstImages?: Array<{ dataUrl: string; mime: string }>
}

export interface OpenSessionOutcome {
  sessionId: string
  workspaceDir: string
  evicted: boolean
}

const registry = new Map<string, SessionContext>()
const registryLogger = getLogger('agent-registry')

// ===== 目录锁：同 dir 的 openSession 串行（evict 关旧开新不被并发插队）=====

const dirLocks = new Map<string, Promise<unknown>>()

function withDirLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const prev = dirLocks.get(dir) ?? Promise.resolve()
  const run = prev.then(fn)
  dirLocks.set(
    dir,
    run.catch(() => {}),
  )
  return run
}

// ===== 开启会话 =====

export function openSession(params: OpenSessionParams): Promise<OpenSessionOutcome> {
  const dir = normalizeDir(params.projectPath)
  return withDirLock(dir, async () => {
    const existing = registry.get(dir)
    let evicted = false
    if (existing) {
      if (existing.username !== params.username || !params.evict) {
        // 他人占用：绝不自动关闭；自己占用：前端确认切换后带 evict 重试
        throw new AppError('AGENT_SESSION_BUSY', {
          details: { occupiedBy: occupiedInfo(existing) },
        })
      }
      await closeContext(existing, 'evict')
      evicted = true
    }

    // 配额：全局 / 每用户（锁内 check-then-set 原子；同 dir 已被锁串行）
    if (
      registry.size >= env.AGENT_MAX_TOTAL_SESSIONS ||
      countByUser(params.username) >= env.AGENT_MAX_SESSIONS_PER_USER
    ) {
      throw new AppError('AGENT_SESSION_LIMIT', {
        message: `活跃会话数已达上限（每人 ${env.AGENT_MAX_SESSIONS_PER_USER} 个 / 全局 ${env.AGENT_MAX_TOTAL_SESSIONS} 个）`,
      })
    }

    ensureUserConfigDir(params.username)
    // 新会话预生成 sessionId（经 Options.sessionId 传给 CLI）。CLI 2.x 在首条用户消息前
    // 不发 system/init（streaming-input 模式实测零输出），等 init 才返回会 45s 互等死锁；
    // 预设 id 让 openSession 即时返回，会话文件在首条消息时落地。
    const sessionId = params.resumeSessionId ?? crypto.randomUUID()
    const ctx = createSessionContext(params, dir, sessionId)
    // 同步占位（防同 dir 并发；锁外快照可见 starting 态）
    registry.set(dir, ctx)

    // 首条消息（CLI 收到首条输入才启动会话：init 随之到达，消息按序进入 turn）
    if (params.firstMessage || params.firstImages?.length) {
      pushMessageInternal(ctx, buildUserMessage(params.firstMessage ?? '', params.firstImages))
    }

    return { sessionId, workspaceDir: dir, evicted }
  })
}

function createSessionContext(
  params: OpenSessionParams,
  dir: string,
  sessionId: string,
): SessionContext {
  const abortController = new AbortController()
  const stream = new SdkInputStream(abortController.signal)
  const sessionLogger = getLogger('agent-session').child({
    username: params.username,
    ws: dir,
    sessionId,
  })

  let ctx!: SessionContext
  // 审批终结 → 广播 approval_settled（双 tab 一致性 + 超时呈现）
  const approvals = new ApprovalManager(abortController.signal, (toolCallId, outcome, reason) => {
    broadcast(ctx, {
      event: 'approval_settled',
      data: { toolCallId, outcome, ...(reason ? { reason } : {}) },
    })
  })

  let doneResolve!: () => void
  const done = new Promise<void>((r) => {
    doneResolve = r
  })

  // 翻译循环的 onEvent：先过会话状态机，再广播
  const onEvent = (ev: SSEEvent): void => {
    if (ev.event === 'turn_end') {
      ctx.turns++
      if (ctx.state === 'turn-running') ctx.state = 'idle'
    } else if (ev.event === 'usage') {
      ctx.tokenUsage.inputTokens += ev.data.inputTokens
      ctx.tokenUsage.outputTokens += ev.data.outputTokens
    }
    broadcast(ctx, ev)
  }

  const queryObj = query({
    prompt: stream,
    options: buildSessionQueryOptions({
      username: params.username,
      cwd: dir,
      sessionId: params.resumeSessionId ? undefined : sessionId,
      ...(params.model ? { model: params.model } : {}),
      ...(params.resumeSessionId ? { resume: params.resumeSessionId } : {}),
      abortController,
      canUseTool: makeCanUseTool(() => ctx, approvals),
      sessionLogger,
    }),
  })

  ctx = {
    username: params.username,
    workspaceDir: dir,
    sessionId,
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    state: 'starting',
    turns: 0,
    tokenUsage: { inputTokens: 0, outputTokens: 0 },
    stream,
    queryObj,
    abortController,
    sessionLogger,
    approvals,
    subscribers: new Set(),
    buffer: [],
    seq: 0,
    done,
    finalized: false,
  }

  void translateSessionStream(queryObj, {
    onEvent,
    onSessionId: (sid) => {
      if (ctx.sessionId !== sid) {
        // 以 SDK 为准（resume 场景 JSONL 被压缩/迁移后可能换 id；新会话正常应相等）
        sessionLogger.warn(
          { expected: ctx.sessionId, actual: sid },
          'SDK 返回了不同 session_id，以 SDK 为准',
        )
        ctx.sessionId = sid
      }
    },
    onStreamEnd: () => {
      doneResolve()
      // 无人调 closeSession（子进程自然退出/OOM）→ 就地收尾
      if (ctx.state !== 'closing' && ctx.state !== 'closed') {
        finalizeContext(ctx, 'process_exit')
      }
    },
    abortController,
    sessionLogger,
  }).catch((err) => {
    // abort（关会话）路径不报错；其它异常推 error 事件（随后 onStreamEnd 已广播 query_closed）
    if (!abortController.signal.aborted) {
      broadcast(ctx, {
        event: 'error',
        data: { message: err instanceof Error ? err.message : String(err) },
      })
    }
  })

  return ctx
}

/** canUseTool：仅命令类 + AskUserQuestion 走人工审批，其余直接放行 */
function makeCanUseTool(
  getContext: () => SessionContext,
  approvals: ApprovalManager,
): CanUseToolFn {
  return async (toolName, input, opts) => {
    if (!needsApproval(toolName)) {
      return { behavior: 'allow' }
    }
    const ctx = getContext()
    broadcast(ctx, {
      event: 'approval_request',
      data: {
        toolCallId: opts.toolUseID,
        toolName,
        input,
        ...(opts.suggestions ? { suggestions: opts.suggestions } : {}),
        expiresAt: Date.now() + APPROVAL_TIMEOUT_MS,
      },
    })
    broadcast(ctx, { event: 'status', data: { status: 'awaiting-approval' } })
    try {
      const decision = await approvals.request({
        toolCallId: opts.toolUseID,
        toolName,
        input,
        signal: opts.signal,
        ...(opts.suggestions ? { suggestions: opts.suggestions } : {}),
      })
      broadcast(ctx, { event: 'status', data: { status: 'tool-use' } })
      if (decision.allowed) {
        return {
          behavior: 'allow',
          ...(decision.modifiedInput ? { updatedInput: decision.modifiedInput } : {}),
        }
      }
      const denyMsg = toolName === 'AskUserQuestion' ? '用户拒绝了此问题' : '用户拒绝了此工具调用'
      return { behavior: 'deny', message: decision.feedback ?? denyMsg }
    } catch {
      broadcast(ctx, { event: 'status', data: { status: 'tool-use' } })
      return { behavior: 'deny', message: '审批过程出错' }
    }
  }
}

// ===== 消息 / 审批 / 中断 =====

/** 构造 SDKUserMessage（text + 可选图片 block） */
export function buildUserMessage(
  text: string,
  images?: Array<{ dataUrl: string; mime: string }>,
): SDKUserMessage {
  if (!images || images.length === 0) {
    return {
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      uuid: crypto.randomUUID(),
    }
  }
  const blocks: unknown[] = []
  if (text) blocks.push({ type: 'text', text })
  for (const img of images) {
    blocks.push({
      type: 'image',
      source: { type: 'base64', media_type: img.mime, data: img.dataUrl.split(',')[1] ?? '' },
    })
  }
  // image block 的精确类型校验由 SDK 接管；此处按 Anthropic Messages API 形状构造后断言
  return {
    type: 'user',
    message: { role: 'user', content: blocks },
    parent_tool_use_id: null,
    uuid: crypto.randomUUID(),
  } as SDKUserMessage
}

/** 发消息；turn 进行中返回 {queued:true}（排队语义，立即纠偏走 interrupt 再发） */
export function sendMessage(ctx: SessionContext, msg: SDKUserMessage): { queued: boolean } {
  if (ctx.state === 'closing' || ctx.state === 'closed') {
    throw new AppError('AGENT_SESSION_CLOSING')
  }
  ctx.lastActiveAt = Date.now()
  const queued = ctx.state === 'turn-running' || ctx.state === 'starting'
  ctx.state = 'turn-running'
  ctx.stream.push(msg)
  return { queued }
}

function pushMessageInternal(ctx: SessionContext, msg: SDKUserMessage): void {
  ctx.lastActiveAt = Date.now()
  ctx.state = 'turn-running'
  ctx.stream.push(msg)
}

/** 审批作答（updatedInput 白名单校验在 service 层）；已处理/超时 → 409 */
export function resolveApproval(
  ctx: SessionContext,
  toolCallId: string,
  decision: ApprovalDecision,
): void {
  ctx.lastActiveAt = Date.now()
  if (!ctx.approvals.resolve(toolCallId, decision)) {
    throw new AppError('AGENT_APPROVAL_NOT_FOUND')
  }
}

/** 中断当前 turn（保活会话） */
export function interruptSession(ctx: SessionContext): void {
  ctx.lastActiveAt = Date.now()
  ctx.queryObj.interrupt().catch((err) => {
    ctx.sessionLogger.warn({ err }, 'interrupt 调用失败')
  })
}

// ===== 查询 =====

export function getActiveSession(dir: string): SessionContext | undefined {
  return registry.get(normalizeDir(dir))
}

/** 全部活跃会话快照（看板统计用；只读视图，调用方不得 mutate） */
export function getActiveSnapshot(): readonly SessionContext[] {
  return [...registry.values()]
}

export function occupiedInfo(ctx: SessionContext): OccupiedInfoData {
  return {
    username: ctx.username,
    sessionId: ctx.sessionId,
    state: ctx.state,
    idleMinutes: Math.floor((Date.now() - ctx.lastActiveAt) / 60_000),
  }
}

/** SSE 重连重放：lastSeq 之后的事件（null = 全量） */
export function eventsSince(ctx: SessionContext, lastSeq: number | null): SequencedEvent[] {
  if (lastSeq === null) return [...ctx.buffer]
  const idx = ctx.buffer.findIndex((m) => m.seq > lastSeq)
  return idx === -1 ? [] : ctx.buffer.slice(idx)
}

export function subscribe(ctx: SessionContext, send: (msg: SequencedEvent) => void): void {
  ctx.subscribers.add(send)
}

export function unsubscribe(ctx: SessionContext, send: (msg: SequencedEvent) => void): void {
  ctx.subscribers.delete(send)
}

/** 显式操作刷新活动时间（attach 算活动；SSE 连接与心跳不算） */
export function touchSession(ctx: SessionContext): void {
  ctx.lastActiveAt = Date.now()
}

// ===== 关闭 =====

/** 业务关闭入口（用户主动/登出/evict/janitor）；幂等 */
export async function closeSessionByDir(dir: string, reason: SessionCloseReason): Promise<void> {
  const ctx = registry.get(normalizeDir(dir))
  if (!ctx) return
  await closeContext(ctx, reason)
}

async function closeContext(ctx: SessionContext, reason: SessionCloseReason): Promise<void> {
  if (ctx.state === 'closing' || ctx.state === 'closed') {
    await ctx.done.catch(() => {})
    return
  }
  ctx.state = 'closing'
  // 清空挂起审批：deny + approval_settled(closed)，防 Promise 泄漏与子进程等待卡死
  ctx.approvals.closeAll()
  ctx.abortController.abort()
  try {
    await ctx.done
  } catch {
    /* 翻译循环异常已作为 error 事件广播 */
  }
  finalizeContext(ctx, reason)
}

/** 终态收尾：广播 query_closed → stats 落库 → 移出注册表（防重入） */
function finalizeContext(ctx: SessionContext, reason: SessionCloseReason): void {
  if (ctx.finalized) return
  ctx.finalized = true
  ctx.state = 'closed'
  broadcast(ctx, { event: 'query_closed', data: { reason } })
  ctx.sessionLogger.info(
    { reason, turns: ctx.turns, ...ctx.tokenUsage, lifeCycleMs: Date.now() - ctx.createdAt },
    '会话已关闭',
  )
  agentRepository
    .insertSessionStats(db, {
      sessionId: ctx.sessionId,
      workspaceDir: ctx.workspaceDir,
      username: ctx.username,
      startedAt: new Date(ctx.createdAt),
      closedAt: new Date(),
      lifeCycleMs: Date.now() - ctx.createdAt,
      lastActiveAt: new Date(ctx.lastActiveAt),
      turns: ctx.turns,
      inputTokens: ctx.tokenUsage.inputTokens,
      outputTokens: ctx.tokenUsage.outputTokens,
      closeReason: reason,
    })
    .catch((err) => {
      ctx.sessionLogger.error({ err }, '会话统计落库失败（不影响关闭）')
    })
  registry.delete(ctx.workspaceDir)
}

export async function closeAllSessionsForUser(
  username: string,
  reason: SessionCloseReason = 'logout',
): Promise<void> {
  const targets = [...registry.values()].filter((c) => c.username === username)
  await Promise.all(targets.map((c) => closeContext(c, reason)))
}

export async function closeAllAgentSessions(
  reason: SessionCloseReason = 'shutdown',
): Promise<void> {
  await Promise.all([...registry.values()].map((c) => closeContext(c, reason)))
}

// ===== 广播 =====

function broadcast(ctx: SessionContext, ev: SSEEvent): void {
  const msg: SequencedEvent = { seq: ++ctx.seq, ...ev }
  ctx.buffer.push(msg)
  if (ctx.buffer.length > BUFFER_CAPACITY) ctx.buffer.shift()
  for (const send of ctx.subscribers) {
    try {
      send(msg)
    } catch {
      ctx.subscribers.delete(send)
    }
  }
}

// ===== janitor：时间类清理统一收敛（60s 扫描）=====

const janitor = setInterval(() => {
  const now = Date.now()
  for (const ctx of registry.values()) {
    if (ctx.state === 'closing' || ctx.state === 'closed') continue
    // 绝对寿命兜底（防病态会话；turn 进行中也回收）
    if (now - ctx.createdAt > env.AGENT_SESSION_MAX_LIFE_HOURS * 3_600_000) {
      registryLogger.warn(
        { ws: ctx.workspaceDir, username: ctx.username },
        '会话超过绝对寿命，强制回收',
      )
      void closeContext(ctx, 'life_limit')
      continue
    }
    // 空闲回收：idle 且超时无显式操作（发消息/审批/interrupt/attach 刷新；SSE 连接不算）
    if (ctx.state === 'idle' && now - ctx.lastActiveAt > env.AGENT_SESSION_IDLE_MINUTES * 60_000) {
      registryLogger.info({ ws: ctx.workspaceDir, username: ctx.username }, '会话空闲回收')
      void closeContext(ctx, 'idle_gc')
    }
  }
}, 60_000)
janitor.unref?.()

// ===== 启动清扫：杀死上次崩溃遗留的 SDK 孤儿子进程 =====

/** claude.exe 位于 node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/，可执行路径含 claude-agent-sdk 即为 SDK 子进程 */
export async function startupOrphanSweep(): Promise<void> {
  if (process.platform !== 'win32') return
  // 服务刚启动不存在合法子进程，见即孤儿（Windows 父死子不死且无 Job Object 兜底）
  const script =
    "Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '*claude-agent-sdk*' } | ForEach-Object { Write-Output $_.ProcessId; taskkill /F /PID $_.ProcessId }"
  try {
    const proc = Bun.spawnSync(['powershell', '-NoProfile', '-Command', script])
    const out = proc.stdout.toString().trim()
    const pids = out
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /^\d+$/.test(l))
    if (pids.length > 0) {
      registryLogger.warn({ pids }, '启动清扫：终止孤儿 claude 子进程')
    }
  } catch (err) {
    registryLogger.warn({ err }, '启动清扫失败（不影响服务启动）')
  }
}

// ===== 内部工具 =====

function countByUser(username: string): number {
  let n = 0
  for (const c of registry.values()) {
    if (c.username === username) n++
  }
  return n
}
