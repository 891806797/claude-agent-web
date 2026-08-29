import { readdir, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import {
  type Query,
  query,
  type ModelInfo as SDKModelInfo,
  type SlashCommand as SDKSlashCommand,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import { AppError } from '@/core/app-error'
import { getLogger, log } from '@/core/logger'
import { db } from '@/db'
import { env } from '@/env'
import { authRepository } from '@/modules/auth/auth.repository'
import type { PageQuery } from '@/utils/pagination'
import { getOffset } from '@/utils/pagination'
import { agentRepository } from './agent.repository'
import type { ApprovalData, CreateProjectData, OpenSessionData, Project } from './agent.schema'
import { toProject } from './agent.schema'
import { buildProbeQueryOptions } from './agent-query-options'
import {
  deleteUserSession,
  getUserSessionMessages,
  listUserSessions,
  renameUserSession,
} from './agent-session-history'
import type { PendingApprovalView } from './approval-manager'
import { normalizeDir } from './paths'
import type { SessionContext } from './session-registry'
import * as registry from './session-registry'
import type { ChatMessage, ModelInfo, SanitizedSession, SlashCommand } from './sse-events'

/**
 * agent 业务层 —— 不 import hono 任何内容（可独立单测）。
 *
 * 多人共用安全口径（与单用户 desktop 的本质差异，全部收敛在此层）：
 * - username 一律来自 JWT（route 层 c.get('username')），绝不信任客户端输入
 * - 历史读写经 withUserConfigDir 物理隔离（每用户独立 CLAUDE_CONFIG_DIR）
 * - 活跃会话操作经 requireSessionCtx 属主校验，非属主统一 404（不泄露他人会话存在性）
 * - probe 缓存按 `${username}:${dir}` 键控（不同用户项目级 skills/命令可不同）
 */

// ===== 项目 =====

async function listProjects(): Promise<Project[]> {
  const rows = await agentRepository.listProjects(db)
  return rows.map(toProject)
}

async function createProject(username: string, data: CreateProjectData): Promise<Project> {
  const dir = normalizeDir(data.path)
  if (env.AGENT_WORKSPACE_ROOT) {
    const root = normalizeDir(env.AGENT_WORKSPACE_ROOT)
    if (dir !== root && !dir.startsWith(`${root}/`)) {
      throw new AppError('AGENT_PROJECT_PATH_INVALID', {
        message: `项目路径必须位于 ${env.AGENT_WORKSPACE_ROOT} 之下`,
      })
    }
  }
  let st: Awaited<ReturnType<typeof stat>>
  try {
    st = await stat(dir)
  } catch {
    throw new AppError('AGENT_PROJECT_PATH_INVALID', { message: '目录不存在或不可访问' })
  }
  if (!st.isDirectory()) {
    throw new AppError('AGENT_PROJECT_PATH_INVALID', { message: '路径必须是目录' })
  }
  if (await agentRepository.findProjectByPath(db, dir)) {
    throw new AppError('AGENT_PROJECT_PATH_EXISTS')
  }
  const row = await agentRepository.createProject(db, {
    name: data.name,
    path: dir,
    createdBy: username,
  })
  log().info({ projectId: row.id, path: dir, username }, '项目已注册')
  return toProject(row)
}

async function removeProject(id: string): Promise<void> {
  const row = await agentRepository.findProjectById(db, id)
  if (!row) {
    throw new AppError('AGENT_PROJECT_NOT_FOUND')
  }
  // 活跃会话存在（无论属主）即拒绝删除：删白名单会导致会话失去 resume 边界
  const active = registry.getActiveSession(row.path)
  if (active) {
    throw new AppError('AGENT_SESSION_BUSY', {
      details: { occupiedBy: registry.occupiedInfo(active) },
    })
  }
  // 注：与 openSession 存在极窄竞态窗口（并发注册/删除），后果仅为会话失去可 resume 性，可接受
  const removed = await agentRepository.removeProject(db, id)
  if (!removed) {
    throw new AppError('AGENT_PROJECT_NOT_FOUND')
  }
  log().info({ projectId: id }, '项目已移除')
}

/** 项目 id → 归一化路径（白名单边界） */
async function requireProjectDir(projectId: string): Promise<string> {
  const row = await agentRepository.findProjectById(db, projectId)
  if (!row) {
    throw new AppError('AGENT_PROJECT_NOT_FOUND')
  }
  return row.path
}

// ===== 会话历史（SDK JSONL，按用户物理隔离）=====

async function listSessions(
  username: string,
  projectId: string,
  page: PageQuery,
): Promise<SanitizedSession[]> {
  const dir = await requireProjectDir(projectId)
  return listUserSessions(username, dir, { limit: page.pageSize, offset: getOffset(page) })
}

async function getSessionMessages(
  username: string,
  workspaceDir: string,
  sessionId: string,
): Promise<ChatMessage[]> {
  return getUserSessionMessages(username, sessionId, workspaceDir)
}

async function deleteSession(
  username: string,
  workspaceDir: string,
  sessionId: string,
): Promise<void> {
  const active = registry.getActiveSession(workspaceDir)
  if (active && active.sessionId === sessionId) {
    // Windows：子进程退出前 JSONL 被锁，先等关闭完成再删文件
    await registry.closeSessionByDir(workspaceDir, 'user_close')
  }
  await deleteUserSession(username, sessionId, workspaceDir)
}

async function renameSession(
  username: string,
  workspaceDir: string,
  sessionId: string,
  title: string,
): Promise<void> {
  await renameUserSession(username, sessionId, workspaceDir, title)
}

// ===== 活跃会话操作 =====

/**
 * 活跃会话解析（会话操作统一入口）。
 * 四种失败（不存在/已不活跃/sid 不匹配/非属主）统一 404——不泄露他人会话存在性。
 */
export function requireSessionCtx(
  username: string,
  workspaceDir: string,
  sessionId: string,
): SessionContext {
  const ctx = registry.getActiveSession(workspaceDir)
  if (!ctx || ctx.sessionId !== sessionId || ctx.username !== username) {
    throw new AppError('AGENT_SESSION_NOT_FOUND', {
      message: '会话不存在或已不活跃，请刷新页面恢复',
    })
  }
  return ctx
}

async function openSession(username: string, data: OpenSessionData) {
  const projectPath = await requireProjectDir(data.projectId)
  const outcome = await registry.openSession({
    username,
    projectPath,
    ...(data.resumeSessionId ? { resumeSessionId: data.resumeSessionId } : {}),
    ...(data.model ? { model: data.model } : {}),
    ...(data.firstMessage ? { firstMessage: data.firstMessage } : {}),
    ...(data.evict ? { evict: true } : {}),
  })
  log().info(
    {
      username,
      sessionId: outcome.sessionId,
      ws: outcome.workspaceDir,
      evicted: outcome.evicted,
      resume: Boolean(data.resumeSessionId),
    },
    '会话已开启',
  )
  return outcome
}

async function sendMessage(
  username: string,
  workspaceDir: string,
  sessionId: string,
  data: { text: string; images?: Array<{ dataUrl: string; mime: string }> },
): Promise<{ queued: boolean }> {
  const ctx = requireSessionCtx(username, workspaceDir, sessionId)
  return registry.sendMessage(ctx, registry.buildUserMessage(data.text, data.images))
}

async function approve(
  username: string,
  workspaceDir: string,
  sessionId: string,
  data: ApprovalData,
): Promise<void> {
  const ctx = requireSessionCtx(username, workspaceDir, sessionId)
  const pending = ctx.approvals.getPending().find((p) => p.toolCallId === data.toolCallId)
  if (!pending) {
    throw new AppError('AGENT_APPROVAL_NOT_FOUND')
  }
  const modifiedInput = buildModifiedInput(pending, data)
  registry.resolveApproval(ctx, data.toolCallId, {
    allowed: data.allowed,
    ...(modifiedInput ? { modifiedInput } : {}),
    ...(data.feedback ? { feedback: data.feedback } : {}),
    ...(data.alwaysAllow ? { alwaysAllow: true } : {}),
  })
}

async function interrupt(username: string, workspaceDir: string, sessionId: string): Promise<void> {
  registry.interruptSession(requireSessionCtx(username, workspaceDir, sessionId))
}

/** 回滚文件到指定 checkpoint（user message uuid）；需 enableFileCheckpointing */
async function rewind(
  username: string,
  workspaceDir: string,
  sessionId: string,
  messageId: string,
): Promise<void> {
  const ctx = requireSessionCtx(username, workspaceDir, sessionId)
  await ctx.queryObj.rewindFiles(messageId)
}

async function closeSession(
  username: string,
  workspaceDir: string,
  sessionId: string,
): Promise<void> {
  // 属主校验先行：非属主拿到 ws+sid 也无法关掉他人会话
  requireSessionCtx(username, workspaceDir, sessionId)
  await registry.closeSessionByDir(workspaceDir, 'user_close')
}

async function getActiveSessionInfo(username: string, workspaceDir: string) {
  const ctx = registry.getActiveSession(workspaceDir)
  if (!ctx) {
    return { active: null }
  }
  if (ctx.username !== username) {
    // 他人占用：绝不自动关闭，只返回占用信息供前端提示等待
    return { active: null, occupiedBy: registry.occupiedInfo(ctx) }
  }
  return {
    active: {
      sessionId: ctx.sessionId,
      state: ctx.state,
      startedAt: ctx.createdAt,
      turns: ctx.turns,
    },
  }
}

// ===== updatedInput 白名单（审批安全边界）=====

/**
 * 审批允许修改的工具参数收敛为两类，其余一律 422：
 * - Bash / PowerShell：仅 command 字段（单字段非空字符串）
 * - AskUserQuestion：仅注入 answers/annotations（题目原样保留，防整包替换注入新题）
 */
function buildModifiedInput(
  pending: PendingApprovalView,
  data: ApprovalData,
): Record<string, unknown> | undefined {
  if (!data.updatedInput) return undefined
  if (pending.toolName === 'Bash' || pending.toolName === 'PowerShell') {
    const command = data.updatedInput.command
    if (
      Object.keys(data.updatedInput).length !== 1 ||
      typeof command !== 'string' ||
      command.trim().length === 0
    ) {
      throw new AppError('VALIDATION_ERROR', { message: '命令类审批仅允许修改 command 字段' })
    }
    return { command }
  }
  if (pending.toolName === 'AskUserQuestion') {
    return buildQuestionnaireInput(pending.input, data.updatedInput)
  }
  throw new AppError('VALIDATION_ERROR', { message: '该审批不允许修改工具参数' })
}

/** 问卷作答校验：每题必答（非空字符串，多选逗号拼接），annotations 可选，questions 必须与原输入一致 */
function buildQuestionnaireInput(
  originalInput: Record<string, unknown>,
  updated: Record<string, unknown>,
): Record<string, unknown> {
  const questions = Array.isArray(originalInput.questions) ? originalInput.questions : []
  const { answers, annotations } = updated as { answers?: unknown; annotations?: unknown }
  if (JSON.stringify(updated.questions) !== JSON.stringify(questions)) {
    throw new AppError('VALIDATION_ERROR', { message: '问卷题目不允许修改' })
  }
  if (typeof answers !== 'object' || answers === null) {
    throw new AppError('VALIDATION_ERROR', { message: '问卷缺少回答' })
  }
  const answerMap = answers as Record<string, unknown>
  const cleanAnswers: Record<string, string> = {}
  for (const q of questions) {
    const questionText = (q as { question?: unknown }).question
    if (typeof questionText !== 'string') continue
    const value = answerMap[questionText]
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new AppError('VALIDATION_ERROR', { message: `问题「${questionText}」未作答` })
    }
    cleanAnswers[questionText] = value
  }
  const result: Record<string, unknown> = { questions, answers: cleanAnswers }
  if (typeof annotations === 'object' && annotations !== null) {
    const clean: Record<string, { notes?: string }> = {}
    for (const [key, value] of Object.entries(annotations as Record<string, unknown>)) {
      const notes = (value as { notes?: unknown } | null)?.notes
      if (typeof notes === 'string' && notes.trim().length > 0) {
        clean[key] = { notes }
      }
    }
    if (Object.keys(clean).length > 0) result.annotations = clean
  }
  return result
}

// ===== 斜杠命令 / 模型列表（零 token 探测）=====

/** 探测超时：CLI 握手异常兜底（超时即 abort 探测进程） */
const PROBE_TIMEOUT_MS = 15_000

/** 永不产出 user message 的输入流：CLI 完成 init 握手后静默等待，控制请求照常可发（不产生 token 消耗） */
function neverYieldingIterable(): AsyncIterable<SDKUserMessage> {
  return (async function* (): AsyncGenerator<SDKUserMessage> {
    await new Promise<void>(() => {})
  })()
}

/** 缓存按 `${username}:${dir}` 键控：不同用户 CLAUDE_CONFIG_DIR 不同，项目级 skills/命令可能不同 */
const commandsCache = new Map<string, Promise<SlashCommand[]>>()
const modelsCache = new Map<string, Promise<ModelInfo[]>>()

async function probeControl<T>(
  username: string,
  cwd: string,
  fetcher: (q: Query) => Promise<T>,
): Promise<T> {
  const sessionLogger = getLogger('agent-probe').child({ username, ws: cwd })
  const q = query({
    prompt: neverYieldingIterable(),
    options: buildProbeQueryOptions({ username, cwd, sessionLogger }),
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new AppError('AGENT_SDK_ERROR', { message: 'CLI 探测超时' })),
        PROBE_TIMEOUT_MS,
      )
    })
    // 控制请求 out-of-band 应答，无需等消息流 init（CLI 0.3.250 首条用户消息前消息流零输出，
    // 实测 supportedCommands 0.5s 返回而迭代器无任何消息），直接发起并 raced 超时
    return await Promise.race([fetcher(q), deadline])
  } finally {
    clearTimeout(timer)
    q.close()
  }
}

/** get-or-set 缓存：失败不缓存（下次重试）；并发同 key 共享同一探测进程 */
function cachedProbe<T>(
  cache: Map<string, Promise<T>>,
  key: string,
  run: () => Promise<T>,
): Promise<T> {
  let p = cache.get(key)
  if (!p) {
    p = run().catch((err: unknown) => {
      cache.delete(key)
      throw err
    })
    cache.set(key, p)
  }
  return p
}

async function getCommands(username: string, projectId: string): Promise<SlashCommand[]> {
  const dir = await requireProjectDir(projectId)
  return cachedProbe(commandsCache, `${username}:${dir}`, () =>
    probeControl(username, dir, async (q) => (await q.supportedCommands()).map(toCommandDto)),
  )
}

async function getModels(username: string, projectId: string): Promise<ModelInfo[]> {
  const dir = await requireProjectDir(projectId)
  return cachedProbe(modelsCache, `${username}:${dir}`, () =>
    probeControl(username, dir, async (q) => (await q.supportedModels()).map(toModelDto)),
  )
}

function toCommandDto(cmd: SDKSlashCommand): SlashCommand {
  return {
    name: cmd.name,
    description: cmd.description ?? '',
    argumentHint: cmd.argumentHint ?? '',
    ...(cmd.aliases ? { aliases: cmd.aliases } : {}),
  }
}

function toModelDto(m: SDKModelInfo): ModelInfo {
  return {
    value: m.value,
    displayName: m.displayName,
    description: m.description ?? '',
    ...(m.supportsEffort !== undefined ? { supportsEffort: m.supportsEffort } : {}),
  }
}

// ===== @mention 文件列表（项目目录内，遍历有界 + 进程级缓存）=====

/** 项目文件清单缓存（projectId → 相对路径列表；文件变动需刷新页面） */
const filesCache = new Map<string, string[]>()

/** 遍历项目目录文件（忽略 .git/node_modules/点文件，深度与数量有界防大仓库卡顿） */
async function walkProjectFiles(rootDir: string): Promise<string[]> {
  const result: string[] = []
  const MAX = 2000
  const MAX_DEPTH = 6
  const recurse = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || result.length >= MAX) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (result.length >= MAX) return
      if (e.name.startsWith('.') || e.name === 'node_modules') continue
      const full = join(dir, e.name)
      if (e.isDirectory()) await recurse(full, depth + 1)
      else if (e.isFile()) result.push(relative(rootDir, full).replaceAll('\\', '/'))
    }
  }
  await recurse(rootDir, 0)
  return result
}

async function getFiles(projectId: string, q: string): Promise<string[]> {
  const dir = await requireProjectDir(projectId)
  let list = filesCache.get(projectId)
  if (!list) {
    list = await walkProjectFiles(dir)
    filesCache.set(projectId, list)
  }
  const query = q.toLowerCase()
  if (!query) return list.slice(0, 30)
  return list.filter((p) => p.toLowerCase().includes(query)).slice(0, 30)
}

// ===== 看板统计 =====

/**
 * 看板聚合：活跃态走 registry 内存快照（按 state/user/token），历史态走 agent_session_stats
 * 聚合（总量/今日/token/关闭原因），加项目数与注册用户数。
 * 「在线用户」= 当前有活跃会话的不重复 username（最严格的「正在使用」口径）。
 */
async function getStats(): Promise<{
  active: {
    sessions: number
    users: number
    byState: Record<string, number>
    byUser: Array<{ username: string; count: number }>
    inputTokens: number
    outputTokens: number
  }
  historical: {
    totalSessions: number
    todaySessions: number
    totalInputTokens: number
    totalOutputTokens: number
    byCloseReason: Record<string, number>
  }
  projects: number
  registeredUsers: number
}> {
  const snapshot = registry.getActiveSnapshot()
  const byState: Record<string, number> = {}
  const userCount = new Map<string, number>()
  let inputTokens = 0
  let outputTokens = 0
  for (const ctx of snapshot) {
    byState[ctx.state] = (byState[ctx.state] ?? 0) + 1
    userCount.set(ctx.username, (userCount.get(ctx.username) ?? 0) + 1)
    inputTokens += ctx.tokenUsage.inputTokens
    outputTokens += ctx.tokenUsage.outputTokens
  }
  const byUser = [...userCount.entries()]
    .map(([username, count]) => ({ username, count }))
    .sort((a, b) => b.count - a.count)

  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)
  const historical = await agentRepository.sessionStatsAggregate(db, todayStart)
  const projects = await agentRepository.countProjects(db)
  const registeredUsers = await authRepository.countUsers(db)
  return {
    active: {
      sessions: snapshot.length,
      users: userCount.size,
      byState,
      byUser,
      inputTokens,
      outputTokens,
    },
    historical,
    projects,
    registeredUsers,
  }
}

export const agentService = {
  listProjects,
  createProject,
  removeProject,
  listSessions,
  getSessionMessages,
  deleteSession,
  renameSession,
  openSession,
  sendMessage,
  approve,
  interrupt,
  rewind,
  closeSession,
  getActiveSessionInfo,
  getCommands,
  getModels,
  getFiles,
  getStats,
}
