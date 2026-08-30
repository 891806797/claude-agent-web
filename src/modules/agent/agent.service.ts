import { mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, posix, relative, resolve, sep } from 'node:path'
import {
  type Query,
  query,
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
import type {
  ApprovalData,
  CreatePersonaData,
  CreateProjectData,
  FileContentData,
  OpenSessionData,
  Persona,
  Project,
  SwitchPersonaData,
  UpdatePersonaData,
} from './agent.schema'
import { FilePathSchema, MAX_EDITABLE_FILE_BYTES, toPersona, toProject } from './agent.schema'
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
import type { ChatMessage, SanitizedSession, SlashCommand } from './sse-events'

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

// ===== 智能体定义 =====

async function listPersonas(): Promise<Persona[]> {
  return (await agentRepository.listPersonas(db)).map(toPersona)
}

async function createPersona(data: CreatePersonaData): Promise<Persona> {
  if (await agentRepository.findPersonaByName(db, data.name)) {
    throw new AppError('AGENT_PERSONA_NAME_EXISTS')
  }
  const row = await agentRepository.createPersona(db, data)
  log().info({ personaId: row.id, name: row.name }, '智能体已创建')
  return toPersona(row)
}

async function updatePersona(id: string, data: UpdatePersonaData): Promise<Persona> {
  const existing = await agentRepository.findPersonaById(db, id)
  if (!existing) {
    throw new AppError('AGENT_PERSONA_NOT_FOUND')
  }
  if (
    data.name &&
    data.name !== existing.name &&
    (await agentRepository.findPersonaByName(db, data.name))
  ) {
    throw new AppError('AGENT_PERSONA_NAME_EXISTS')
  }
  const row = await agentRepository.updatePersona(db, id, data)
  if (!row) {
    // 已判存在，此处仅防并发删除的极窄窗口
    throw new AppError('AGENT_PERSONA_NOT_FOUND')
  }
  log().info({ personaId: id }, '智能体已更新')
  return toPersona(row)
}

async function removePersona(id: string): Promise<void> {
  // 绑定快照自足（personaName+systemPrompt 已落库）：删除不影响已开会话的 resume 注入与展示
  const removed = await agentRepository.removePersona(db, id)
  if (!removed) {
    throw new AppError('AGENT_PERSONA_NOT_FOUND')
  }
  log().info({ personaId: id }, '智能体已删除')
}

/** persona 解析结果：append 提示词 + 绑定快照落库所需字段 */
interface ResolvedPersona {
  appendSystemPrompt: string
  personaId: string
  personaName: string
}

/** 显式 personaId → persona 行（404 兜底） */
async function resolvePersona(personaId: string): Promise<ResolvedPersona> {
  const persona = await agentRepository.findPersonaById(db, personaId)
  if (!persona) {
    throw new AppError('AGENT_PERSONA_NOT_FOUND')
  }
  return {
    appendSystemPrompt: persona.systemPrompt,
    personaId: persona.id,
    personaName: persona.name,
  }
}

async function createProject(username: string, data: CreateProjectData): Promise<Project> {
  const dir = normalizeDir(data.path)
  if (env.AGENT_WORKSPACE_ROOT) {
    // normalizeDir 输出是归一化域（win32 已强制正斜杠），分隔符恒为 posix.sep
    const root = normalizeDir(env.AGENT_WORKSPACE_ROOT)
    if (dir !== root && !dir.startsWith(`${root}${posix.sep}`)) {
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
  const active = registry.getActiveSession(dir)
  const sessions = await listUserSessions(username, dir, {
    limit: page.pageSize,
    offset: getOffset(page),
  })
  // personaName 注入：批量查绑定快照（无绑定 = 标准 Claude，缺省不出现）
  const bindings = await agentRepository.findSessionPersonas(
    db,
    sessions.map((s) => s.id),
  )
  const nameBySid = new Map(bindings.map((b) => [b.sessionId, b.personaName]))
  // live 注入：该 workspace 的活跃会话（sid 匹配）标记存活，前端列表显示活点
  return sessions.map((s) => ({
    ...s,
    live: active?.sessionId === s.id,
    ...(nameBySid.get(s.id) ? { personaName: nameBySid.get(s.id)! } : {}),
  }))
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
  // persona 解析优先级：显式 personaId > resume 绑定快照（防人格漂移）> 标准 Claude
  let persona: ResolvedPersona | undefined
  if (data.personaId) {
    persona = await resolvePersona(data.personaId)
  } else if (data.resumeSessionId) {
    const bound = await agentRepository.findSessionPersona(db, data.resumeSessionId)
    if (bound) {
      persona = {
        appendSystemPrompt: bound.systemPrompt,
        personaId: bound.personaId,
        personaName: bound.personaName,
      }
    }
  }
  const outcome = await registry.openSession({
    username,
    projectPath,
    ...(data.resumeSessionId ? { resumeSessionId: data.resumeSessionId } : {}),
    ...(data.firstMessage ? { firstMessage: data.firstMessage } : {}),
    ...(data.evict ? { evict: true } : {}),
    ...(persona ? { appendSystemPrompt: persona.appendSystemPrompt } : {}),
  })
  // 绑定快照落库（幂等覆盖；resume 回填写回同值不变语义。
  // 注：极罕见情况下 SDK resume 后换 sid，绑定仍记请求 sid——该会话下次 resume 退化为标准，可接受）
  if (persona) {
    await agentRepository.upsertSessionPersona(db, {
      sessionId: outcome.sessionId,
      personaId: persona.personaId,
      personaName: persona.personaName,
      systemPrompt: persona.appendSystemPrompt,
    })
  }
  log().info(
    {
      username,
      sessionId: outcome.sessionId,
      ws: outcome.workspaceDir,
      evicted: outcome.evicted,
      resume: Boolean(data.resumeSessionId),
      persona: persona?.personaName,
    },
    '会话已开启',
  )
  return outcome
}

/**
 * 会话切换智能体：锁内 idle 校验（turn 进行中/审批挂起 409）+ evict 替换进程（同 sid
 * resume 重开，历史重放）。personaId 缺省/null = 切回标准 Claude（删绑定）。
 */
async function switchSessionPersona(
  username: string,
  workspaceDir: string,
  sessionId: string,
  data: SwitchPersonaData,
) {
  const persona = data.personaId ? await resolvePersona(data.personaId) : undefined
  const outcome = await registry.switchSessionPersona({
    username,
    projectPath: workspaceDir,
    sessionId,
    ...(persona ? { appendSystemPrompt: persona.appendSystemPrompt } : {}),
  })
  if (persona) {
    await agentRepository.upsertSessionPersona(db, {
      sessionId: outcome.sessionId,
      personaId: persona.personaId,
      personaName: persona.personaName,
      systemPrompt: persona.appendSystemPrompt,
    })
  } else {
    await agentRepository.deleteSessionPersona(db, outcome.sessionId)
  }
  log().info({ username, sessionId, persona: persona?.personaName ?? '(标准)' }, '会话智能体已切换')
  return outcome
}

async function sendMessage(
  username: string,
  workspaceDir: string,
  sessionId: string,
  data: { text: string; images?: Array<{ dataUrl: string; mime: string }> },
): Promise<{ queued: boolean }> {
  const ctx = requireSessionCtx(username, workspaceDir, sessionId)
  const result = registry.sendMessage(ctx, registry.buildUserMessage(data.text, data.images))
  // 占位标题改写：空会话首条消息把"新会话"换为消息摘要（对齐既有 UX：标题≈首条消息；
  // customTitle 会遮蔽 SDK 的 firstPrompt 摘要，不写则列表永远显示"新会话"）。best-effort。
  if (ctx.untitled && data.text.trim()) {
    ctx.untitled = false
    renameUserSession(username, sessionId, workspaceDir, buildSessionTitle(data.text)).catch(
      (err) => {
        log().warn({ err, sessionId }, '会话标题自动改写失败')
      },
    )
  }
  return result
}

/** 会话标题摘要：首行、空白折叠为单空格、按码点截断至 50 字符 */
function buildSessionTitle(text: string): string {
  const firstLine = text.trim().split(/\r?\n/)[0] ?? ''
  const collapsed = firstLine.replace(/\s+/g, ' ').trim()
  return Array.from(collapsed).slice(0, 50).join('')
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
  // 绑定快照（DB）是人格事实源：personaId/personaName 供前端选择器校准选中态与显示名
  // （快照不被 persona 增删改影响，attach/切换后回读永远与该会话注入一致）
  const bound = await agentRepository.findSessionPersona(db, ctx.sessionId)
  return {
    active: {
      sessionId: ctx.sessionId,
      state: ctx.state,
      startedAt: ctx.createdAt,
      turns: ctx.turns,
      ...(bound ? { personaId: bound.personaId, personaName: bound.personaName } : {}),
      // 当前生效人格（最后切换/开启值）：前端选择器以此校准显示
      ...(ctx.systemPrompt ? { systemPrompt: ctx.systemPrompt } : {}),
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

function toCommandDto(cmd: SDKSlashCommand): SlashCommand {
  return {
    name: cmd.name,
    description: cmd.description ?? '',
    argumentHint: cmd.argumentHint ?? '',
    ...(cmd.aliases ? { aliases: cmd.aliases } : {}),
  }
}

// ===== @mention 文件列表 / 文件树（项目目录内，遍历有界 + 短 TTL 缓存）=====

/**
 * 项目文件清单缓存：projectId → { list, at }。
 * 短 TTL 让前端轮询/事件触发的刷新能看到增删（多客户端共享同一份 walk 结果，
 * TTL 窗口内的并发请求不重复遍历）；遍历本身有界（2000 文件/6 层），重 walk 代价可控。
 */
const filesCache = new Map<string, { list: string[]; at: number }>()
const FILES_CACHE_TTL_MS = 3_000

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
      // 目录也收集（末尾 / 标记），让前端文件树能显示空目录；
      // @mention 的 all=false 模式会过滤掉目录路径
      if (e.isDirectory()) {
        result.push(`${relative(rootDir, full).split(sep).join('/')}/`)
        await recurse(full, depth + 1)
      } else if (e.isFile()) {
        result.push(relative(rootDir, full).split(sep).join('/'))
      }
    }
  }
  await recurse(rootDir, 0)
  return result
}

async function getFiles(projectId: string, q: string, all = false): Promise<string[]> {
  const dir = await requireProjectDir(projectId)
  const hit = filesCache.get(projectId)
  const fresh = hit && Date.now() - hit.at < FILES_CACHE_TTL_MS
  let list = fresh ? hit.list : undefined
  if (!list) {
    list = await walkProjectFiles(dir)
    filesCache.set(projectId, { list, at: Date.now() })
  }
  if (all) return list // 文件树用：全量（含目录，带末尾 / 标记）
  // @mention 用：仅文件（剥去目录路径）
  const files = list.filter((p) => !p.endsWith('/'))
  const query = q.toLowerCase()
  if (!query) return files.slice(0, 30)
  return files.filter((p) => p.toLowerCase().includes(query)).slice(0, 30)
}

// ===== 项目文件内容（双击在线编辑：读写 1MB 内文本文件） =====

/**
 * 项目内相对路径 → 绝对路径。zod FilePathSchema 已挡穿越（拒绝 `/` 开头、`\\`、`..` 分段），
 * 此处 resolve + 前缀校验是第二道防线（兜底盘符等 zod 未枚举的绝对形态）。
 * 抛 AGENT_FILE_PATH_INVALID 而非静默改写 —— 路径问题必须显式暴露。导出供单测。
 */
export function resolveProjectFile(projectDir: string, relPath: string): string {
  // DB 存的 projectDir 是 normalizeDir 归一化口径（win32 小写+正斜杠），resolve 后
  // 两侧统一为平台分隔符再比前缀，避免把合法项目内文件误判为穿越
  const root = resolve(projectDir)
  const abs = resolve(projectDir, relPath)
  if (abs !== root && !abs.startsWith(`${root}${sep}`)) {
    throw new AppError('AGENT_FILE_PATH_INVALID')
  }
  return abs
}

async function readFileContent(projectId: string, relPath: string): Promise<FileContentData> {
  const dir = await requireProjectDir(projectId)
  const abs = resolveProjectFile(dir, relPath)
  const info = await stat(abs).catch(() => null)
  if (!info?.isFile()) throw new AppError('AGENT_FILE_NOT_FOUND')
  if (info.size > MAX_EDITABLE_FILE_BYTES) throw new AppError('AGENT_FILE_TOO_LARGE')
  const buf = await readFile(abs)
  // NUL 探测（前 8KB 足以识别）：合法 UTF-8 文本不含 0x00
  if (buf.subarray(0, 8000).includes(0)) throw new AppError('AGENT_FILE_BINARY')
  return { path: relPath, content: buf.toString('utf8'), size: info.size }
}

async function saveFileContent(
  projectId: string,
  relPath: string,
  content: string,
): Promise<{ path: string; size: number }> {
  const dir = await requireProjectDir(projectId)
  const abs = resolveProjectFile(dir, relPath)
  const info = await stat(abs).catch(() => null)
  // 仅允许改已存在文件（编辑入口来自文件清单），不经 API 创建新文件
  if (!info?.isFile()) throw new AppError('AGENT_FILE_NOT_FOUND')
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > MAX_EDITABLE_FILE_BYTES) throw new AppError('AGENT_FILE_TOO_LARGE')
  await writeFile(abs, content, 'utf8')
  log().info({ projectId, path: relPath, bytes }, '项目文件已保存')
  return { path: relPath, size: bytes }
}

// ===== 项目文件管理（工具栏上传/创建 + 右键删除/移动；文件与目录统一入口） =====

/** 创建文件（父目录递归创建；已存在 409）。与 PUT /file 分离——后者仅覆盖已存在文件 */
async function createFile(
  projectId: string,
  relPath: string,
  content = '',
): Promise<{ path: string; size: number }> {
  const dir = await requireProjectDir(projectId)
  const abs = resolveProjectFile(dir, relPath)
  if (await stat(abs).catch(() => null)) throw new AppError('AGENT_FILE_EXISTS')
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > MAX_EDITABLE_FILE_BYTES) throw new AppError('AGENT_FILE_TOO_LARGE')
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, content, 'utf8')
  log().info({ projectId, path: relPath, bytes }, '项目文件已创建')
  filesCache.delete(projectId)
  return { path: relPath, size: bytes }
}

/** 创建目录（递归创建中间层级；已存在 409） */
async function createDir(projectId: string, relPath: string): Promise<{ path: string }> {
  const dir = await requireProjectDir(projectId)
  const abs = resolveProjectFile(dir, relPath)
  if (await stat(abs).catch(() => null)) throw new AppError('AGENT_FILE_EXISTS')
  await mkdir(abs, { recursive: true })
  log().info({ projectId, path: relPath }, '项目目录已创建')
  filesCache.delete(projectId)
  return { path: relPath }
}

/** 删除文件或目录（目录递归删除，前端确认框已明示；不存在/非常规类型 404） */
async function deletePath(projectId: string, relPath: string): Promise<void> {
  const dir = await requireProjectDir(projectId)
  const abs = resolveProjectFile(dir, relPath)
  const info = await stat(abs).catch(() => null)
  if (!info) throw new AppError('AGENT_FILE_NOT_FOUND')
  if (info.isDirectory()) await rm(abs, { recursive: true })
  else if (info.isFile()) await unlink(abs)
  else throw new AppError('AGENT_FILE_NOT_FOUND')
  log().info(
    { projectId, path: relPath, kind: info.isDirectory() ? 'dir' : 'file' },
    '项目路径已删除',
  )
  filesCache.delete(projectId)
}

/**
 * 移动/重命名文件或目录。目标父目录不存在时自动创建（递归）；
 * 目录移入自身内部会造成环形结构，显式拒绝。
 */
async function movePath(
  projectId: string,
  from: string,
  to: string,
): Promise<{ from: string; to: string }> {
  if (from === to) return { from, to }
  const dir = await requireProjectDir(projectId)
  const fromAbs = resolveProjectFile(dir, from)
  const info = await stat(fromAbs).catch(() => null)
  if (!info) throw new AppError('AGENT_FILE_NOT_FOUND')
  const toAbs = resolveProjectFile(dir, to)
  if (info.isDirectory() && toAbs.startsWith(`${fromAbs}${sep}`)) {
    throw new AppError('AGENT_FILE_PATH_INVALID', { message: '不能将目录移动到自身内部' })
  }
  if (await stat(toAbs).catch(() => null)) throw new AppError('AGENT_FILE_EXISTS')
  await mkdir(dirname(toAbs), { recursive: true })
  await rename(fromAbs, toAbs)
  log().info({ projectId, from, to, kind: info.isDirectory() ? 'dir' : 'file' }, '项目路径已移动')
  filesCache.delete(projectId)
  return { from, to }
}

/**
 * 批量上传文件（前端转 base64 走 JSON，规避 multipart 在 zod-openapi 管线外的特例）。
 * 冲突与大小先整体预检（任一不通过即全部拒绝，不留半写状态）。
 */
async function uploadFiles(
  projectId: string,
  dir: string,
  files: Array<{ name: string; contentBase64: string }>,
): Promise<{ saved: string[] }> {
  const root = await requireProjectDir(projectId)
  const entries = files.map((f) => {
    // 协议域拼接：目标相对路径 = 目录 + 文件名（zod 已保证 name 无分隔符/穿越）
    const rel = posix.join(dir, f.name)
    if (!FilePathSchema.safeParse(rel).success) throw new AppError('AGENT_FILE_PATH_INVALID')
    return { rel, abs: resolveProjectFile(root, rel), buf: Buffer.from(f.contentBase64, 'base64') }
  })
  for (const e of entries) {
    if (await stat(e.abs).catch(() => null)) {
      throw new AppError('AGENT_FILE_EXISTS', { message: `文件已存在：${e.rel}` })
    }
    if (e.buf.byteLength > MAX_EDITABLE_FILE_BYTES) {
      throw new AppError('AGENT_FILE_TOO_LARGE', { message: `文件超过 1MB：${e.rel}` })
    }
  }
  for (const e of entries) {
    await mkdir(dirname(e.abs), { recursive: true })
    await writeFile(e.abs, e.buf)
  }
  log().info({ projectId, dir, count: entries.length }, '项目文件已上传')
  filesCache.delete(projectId)
  return { saved: entries.map((e) => e.rel) }
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
  listPersonas,
  createPersona,
  updatePersona,
  removePersona,
  switchSessionPersona,
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
  getFiles,
  readFileContent,
  saveFileContent,
  createFile,
  createDir,
  deletePath,
  movePath,
  uploadFiles,
  getStats,
}
