import { createRoute, z } from '@hono/zod-openapi'
import { streamSSE } from 'hono/streaming'
import { ApiResponseSchema, created, ErrorResponseSchema, jsonResponse, ok } from '@/core/response'
import type { App } from '@/core/types'
import { PageQuerySchema } from '@/utils/pagination'
import {
  ActiveSessionResult,
  ApprovalInput,
  ChatMessageDto,
  CreatePersonaInput,
  CreateProjectInput,
  OpenSessionInput,
  OpenSessionResult,
  PersonaDto,
  ProjectDto,
  RenameSessionInput,
  RewindInput,
  SendMessageInput,
  SendMessageResult,
  SessionHeaders,
  SessionSummaryDto,
  SlashCommandDto,
  SwitchPersonaInput,
  UpdatePersonaInput,
} from './agent.schema'
import { agentService, requireSessionCtx } from './agent.service'
import { decodeDir, normalizeDir } from './paths'
import * as registry from './session-registry'
import type { SequencedEvent } from './sse-events'

/**
 * agent 路由层 —— handler 只做三件事：c.req.valid() -> service -> ok/created。
 * 禁止在 handler 写业务逻辑或 try-catch（错误由全局 error-handler 统一处理）。
 *
 * 例外：SSE 端点走 app.get + streamSSE（无 JSON 响应体，硬套 createRoute 不产生价值）。
 *
 * 会话操作协议：POST/DELETE 类携带 header x-session-id + x-workspace-dir(base64url)；
 * SSE 端点走 query（EventSource 不支持自定义 header）。身份一律取 JWT 解出的 username。
 */

/** SSE 心跳间隔：覆盖 Bun.serve idleTimeout(30s) 与 vite dev proxy 空闲断连 */
const SSE_HEARTBEAT_MS = 15_000

const NoContent = { description: '成功（无响应体）' }

// ===== 项目 =====

const listProjectsRoute = createRoute({
  method: 'get',
  path: '/projects',
  tags: ['agent-project'],
  summary: '项目列表（cwd 白名单）',
  responses: {
    200: jsonResponse(ApiResponseSchema(z.array(ProjectDto)), '成功'),
  },
})

const createProjectRoute = createRoute({
  method: 'post',
  path: '/projects',
  tags: ['agent-project'],
  summary: '注册项目（path 须存在于磁盘）',
  request: {
    body: { required: true, content: { 'application/json': { schema: CreateProjectInput } } },
  },
  responses: {
    201: jsonResponse(ApiResponseSchema(ProjectDto), '已创建'),
    409: jsonResponse(ErrorResponseSchema, '路径已注册'),
    422: jsonResponse(ErrorResponseSchema, '路径非法或不存在'),
  },
})

const removeProjectRoute = createRoute({
  method: 'delete',
  path: '/projects/{id}',
  tags: ['agent-project'],
  summary: '移除项目（有活跃会话时 409）',
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    204: NoContent,
    404: jsonResponse(ErrorResponseSchema, '项目不存在'),
    409: jsonResponse(ErrorResponseSchema, '存在活跃会话'),
  },
})

// ===== 会话开启 / 接入 =====

const openSessionRoute = createRoute({
  method: 'post',
  path: '/sessions',
  tags: ['agent-session'],
  summary: '开会话（新开/resume；同目录被占无 evict 时 409）',
  request: {
    body: { required: true, content: { 'application/json': { schema: OpenSessionInput } } },
  },
  responses: {
    201: jsonResponse(ApiResponseSchema(OpenSessionResult), '已开启'),
    404: jsonResponse(ErrorResponseSchema, '项目不存在'),
    409: jsonResponse(ErrorResponseSchema, '目录被占用 / 会话数超限'),
    500: jsonResponse(ErrorResponseSchema, 'CLI 启动失败'),
  },
})

const activeSessionRoute = createRoute({
  method: 'get',
  path: '/sessions/active',
  tags: ['agent-session'],
  summary: '该 workspaceDir 当前活跃会话（统一接入模型入口）',
  request: {
    query: z.object({ ws: z.string().regex(/^[A-Za-z0-9_-]+$/) }),
  },
  responses: {
    200: jsonResponse(ApiResponseSchema(ActiveSessionResult), '成功'),
  },
})

const listSessionsRoute = createRoute({
  method: 'get',
  path: '/sessions',
  tags: ['agent-session'],
  summary: '项目下历史会话列表（SDK JSONL；无 total，仅分页窗口）',
  request: {
    query: PageQuerySchema.extend({ projectId: z.string().uuid() }),
  },
  responses: {
    200: jsonResponse(ApiResponseSchema(z.array(SessionSummaryDto)), '成功'),
    404: jsonResponse(ErrorResponseSchema, '项目不存在'),
  },
})

// ===== 会话操作（header 协议）=====

const getMessagesRoute = createRoute({
  method: 'get',
  path: '/session/messages',
  tags: ['agent-session'],
  summary: '历史消息（ChatMessage[]，与流式渲染同构）',
  request: { headers: SessionHeaders },
  responses: {
    200: jsonResponse(ApiResponseSchema(z.array(ChatMessageDto)), '成功'),
    404: jsonResponse(ErrorResponseSchema, '会话不存在'),
  },
})

const sendMessageRoute = createRoute({
  method: 'post',
  path: '/session/messages',
  tags: ['agent-session'],
  summary: '发消息（turn 进行中返回 queued:true 排队语义）',
  request: {
    headers: SessionHeaders,
    body: { required: true, content: { 'application/json': { schema: SendMessageInput } } },
  },
  responses: {
    200: jsonResponse(ApiResponseSchema(SendMessageResult), '成功'),
    404: jsonResponse(ErrorResponseSchema, '会话不存在'),
    409: jsonResponse(ErrorResponseSchema, '会话正在关闭'),
    422: jsonResponse(ErrorResponseSchema, '参数错误'),
  },
})

const interruptRoute = createRoute({
  method: 'post',
  path: '/session/interrupt',
  tags: ['agent-session'],
  summary: '中断当前 turn（保活会话）',
  request: { headers: SessionHeaders },
  responses: {
    204: NoContent,
    404: jsonResponse(ErrorResponseSchema, '会话不存在'),
  },
})

const approvalRoute = createRoute({
  method: 'post',
  path: '/session/approvals',
  tags: ['agent-session'],
  summary: '审批作答（Bash/PowerShell 可改 command；AskUserQuestion 注入 answers）',
  request: {
    headers: SessionHeaders,
    body: { required: true, content: { 'application/json': { schema: ApprovalInput } } },
  },
  responses: {
    204: NoContent,
    404: jsonResponse(ErrorResponseSchema, '会话不存在'),
    409: jsonResponse(ErrorResponseSchema, '该审批已被处理'),
    422: jsonResponse(ErrorResponseSchema, 'updatedInput 越权'),
  },
})

const closeRoute = createRoute({
  method: 'post',
  path: '/session/close',
  tags: ['agent-session'],
  summary: '显式关闭会话（历史保留，可再 resume）',
  request: { headers: SessionHeaders },
  responses: {
    204: NoContent,
    404: jsonResponse(ErrorResponseSchema, '会话不存在'),
  },
})

const deleteSessionRoute = createRoute({
  method: 'delete',
  path: '/session',
  tags: ['agent-session'],
  summary: '关闭会话并删除转录 JSONL（不可恢复）',
  request: { headers: SessionHeaders },
  responses: {
    204: NoContent,
    404: jsonResponse(ErrorResponseSchema, '会话不存在'),
  },
})

const renameSessionRoute = createRoute({
  method: 'post',
  path: '/session/rename',
  tags: ['agent-session'],
  summary: '重命名历史会话',
  request: {
    headers: SessionHeaders,
    body: { required: true, content: { 'application/json': { schema: RenameSessionInput } } },
  },
  responses: {
    204: NoContent,
    404: jsonResponse(ErrorResponseSchema, '会话不存在'),
    422: jsonResponse(ErrorResponseSchema, '参数错误'),
  },
})

const rewindRoute = createRoute({
  method: 'post',
  path: '/session/rewind',
  tags: ['agent-session'],
  summary: '回滚文件到 checkpoint（user message uuid）',
  request: {
    headers: SessionHeaders,
    body: { required: true, content: { 'application/json': { schema: RewindInput } } },
  },
  responses: {
    204: NoContent,
    404: jsonResponse(ErrorResponseSchema, '会话不存在'),
    422: jsonResponse(ErrorResponseSchema, '参数错误'),
  },
})

// ===== 智能体定义 =====

const listPersonasRoute = createRoute({
  method: 'get',
  path: '/personas',
  tags: ['agent-persona'],
  summary: '智能体定义列表（全局；输入框选择器与管理页共用）',
  responses: {
    200: jsonResponse(ApiResponseSchema(z.array(PersonaDto)), '成功'),
  },
})

const createPersonaRoute = createRoute({
  method: 'post',
  path: '/personas',
  tags: ['agent-persona'],
  summary: '新建智能体（name 唯一；systemPrompt 原文追加到 claude_code 预设后）',
  request: {
    body: { required: true, content: { 'application/json': { schema: CreatePersonaInput } } },
  },
  responses: {
    201: jsonResponse(ApiResponseSchema(PersonaDto), '已创建'),
    409: jsonResponse(ErrorResponseSchema, '名称已存在'),
    422: jsonResponse(ErrorResponseSchema, '参数错误'),
  },
})

const updatePersonaRoute = createRoute({
  method: 'put',
  path: '/personas/{id}',
  tags: ['agent-persona'],
  summary: '更新智能体（仅影响之后的新会话；已开会话注入快照不受影响）',
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: { required: true, content: { 'application/json': { schema: UpdatePersonaInput } } },
  },
  responses: {
    200: jsonResponse(ApiResponseSchema(PersonaDto), '成功'),
    404: jsonResponse(ErrorResponseSchema, '智能体不存在'),
    409: jsonResponse(ErrorResponseSchema, '名称已存在'),
  },
})

const removePersonaRoute = createRoute({
  method: 'delete',
  path: '/personas/{id}',
  tags: ['agent-persona'],
  summary: '删除智能体（会话绑定存快照，历史会话 resume 不受影响）',
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    204: NoContent,
    404: jsonResponse(ErrorResponseSchema, '智能体不存在'),
  },
})

const switchPersonaRoute = createRoute({
  method: 'put',
  path: '/session/persona',
  tags: ['agent-session'],
  summary: '切换会话智能体（仅 idle 可切；evict 替换进程，同 sid resume 历史重放）',
  request: {
    headers: SessionHeaders,
    body: { required: true, content: { 'application/json': { schema: SwitchPersonaInput } } },
  },
  responses: {
    200: jsonResponse(ApiResponseSchema(OpenSessionResult), '已切换（进程已替换）'),
    404: jsonResponse(ErrorResponseSchema, '会话不存在 / 智能体不存在'),
    409: jsonResponse(ErrorResponseSchema, '会话忙碌（思考/审批中）'),
  },
})

// ===== 探测（零 token）=====

const commandsRoute = createRoute({
  method: 'get',
  path: '/commands',
  tags: ['agent-probe'],
  summary: '斜杠命令列表（零 token 探测，按用户+项目缓存）',
  request: { query: z.object({ projectId: z.string().uuid() }) },
  responses: {
    200: jsonResponse(ApiResponseSchema(z.array(SlashCommandDto)), '成功'),
    404: jsonResponse(ErrorResponseSchema, '项目不存在'),
  },
})

const filesRoute = createRoute({
  method: 'get',
  path: '/files',
  tags: ['agent-probe'],
  summary: '@mention 文件列表（项目目录内，按 q 过滤，遍历有界）',
  request: {
    query: z.object({ projectId: z.string().uuid(), q: z.string().max(200).optional() }),
  },
  responses: {
    200: jsonResponse(ApiResponseSchema(z.array(z.string())), '成功'),
    404: jsonResponse(ErrorResponseSchema, '项目不存在'),
  },
})

// ===== 注册 =====

/** header 协议解码：base64url → 归一化目录（registry 主键口径） */
function headerWorkspaceDir(b64: string): string {
  return normalizeDir(decodeDir(b64))
}

export function registerAgentRoutes(app: App): void {
  // ---- 项目 ----
  app.openapi(listProjectsRoute, async (c) => {
    return ok(c, await agentService.listProjects())
  })

  app.openapi(createProjectRoute, async (c) => {
    return created(c, await agentService.createProject(c.get('username'), c.req.valid('json')))
  })

  app.openapi(removeProjectRoute, async (c) => {
    await agentService.removeProject(c.req.valid('param').id)
    return c.body(null, 204)
  })

  // ---- 智能体定义 ----
  app.openapi(listPersonasRoute, async (c) => {
    return ok(c, await agentService.listPersonas())
  })

  app.openapi(createPersonaRoute, async (c) => {
    return created(c, await agentService.createPersona(c.req.valid('json')))
  })

  app.openapi(updatePersonaRoute, async (c) => {
    return ok(c, await agentService.updatePersona(c.req.valid('param').id, c.req.valid('json')))
  })

  app.openapi(removePersonaRoute, async (c) => {
    await agentService.removePersona(c.req.valid('param').id)
    return c.body(null, 204)
  })

  // ---- 会话开启 / 接入 ----
  app.openapi(openSessionRoute, async (c) => {
    return created(c, await agentService.openSession(c.get('username'), c.req.valid('json')))
  })

  app.openapi(activeSessionRoute, async (c) => {
    const ws = normalizeDir(decodeDir(c.req.valid('query').ws))
    return ok(c, await agentService.getActiveSessionInfo(c.get('username'), ws))
  })

  app.openapi(listSessionsRoute, async (c) => {
    const { projectId, page, pageSize } = c.req.valid('query')
    return ok(c, await agentService.listSessions(c.get('username'), projectId, { page, pageSize }))
  })

  // ---- 会话操作（header 协议）----
  app.openapi(getMessagesRoute, async (c) => {
    const h = c.req.valid('header')
    return ok(
      c,
      await agentService.getSessionMessages(
        c.get('username'),
        headerWorkspaceDir(h['x-workspace-dir']),
        h['x-session-id'],
      ),
    )
  })

  app.openapi(sendMessageRoute, async (c) => {
    const h = c.req.valid('header')
    return ok(
      c,
      await agentService.sendMessage(
        c.get('username'),
        headerWorkspaceDir(h['x-workspace-dir']),
        h['x-session-id'],
        c.req.valid('json'),
      ),
    )
  })

  app.openapi(interruptRoute, async (c) => {
    const h = c.req.valid('header')
    await agentService.interrupt(
      c.get('username'),
      headerWorkspaceDir(h['x-workspace-dir']),
      h['x-session-id'],
    )
    return c.body(null, 204)
  })

  app.openapi(approvalRoute, async (c) => {
    const h = c.req.valid('header')
    await agentService.approve(
      c.get('username'),
      headerWorkspaceDir(h['x-workspace-dir']),
      h['x-session-id'],
      c.req.valid('json'),
    )
    return c.body(null, 204)
  })

  app.openapi(closeRoute, async (c) => {
    const h = c.req.valid('header')
    await agentService.closeSession(
      c.get('username'),
      headerWorkspaceDir(h['x-workspace-dir']),
      h['x-session-id'],
    )
    return c.body(null, 204)
  })

  app.openapi(deleteSessionRoute, async (c) => {
    const h = c.req.valid('header')
    await agentService.deleteSession(
      c.get('username'),
      headerWorkspaceDir(h['x-workspace-dir']),
      h['x-session-id'],
    )
    return c.body(null, 204)
  })

  app.openapi(renameSessionRoute, async (c) => {
    const h = c.req.valid('header')
    await agentService.renameSession(
      c.get('username'),
      headerWorkspaceDir(h['x-workspace-dir']),
      h['x-session-id'],
      c.req.valid('json').title,
    )
    return c.body(null, 204)
  })

  app.openapi(rewindRoute, async (c) => {
    const h = c.req.valid('header')
    await agentService.rewind(
      c.get('username'),
      headerWorkspaceDir(h['x-workspace-dir']),
      h['x-session-id'],
      c.req.valid('json').messageId,
    )
    return c.body(null, 204)
  })

  app.openapi(switchPersonaRoute, async (c) => {
    const h = c.req.valid('header')
    return ok(
      c,
      await agentService.switchSessionPersona(
        c.get('username'),
        headerWorkspaceDir(h['x-workspace-dir']),
        h['x-session-id'],
        c.req.valid('json'),
      ),
    )
  })

  // ---- 探测 ----
  app.openapi(commandsRoute, async (c) => {
    return ok(c, await agentService.getCommands(c.get('username'), c.req.valid('query').projectId))
  })

  app.openapi(filesRoute, async (c) => {
    const { projectId, q } = c.req.valid('query')
    return ok(c, await agentService.getFiles(projectId, q ?? ''))
  })

  // ---- SSE（app.get 例外：无 JSON 响应体）----
  app.get('/session/events', async (c) => {
    const username = c.get('username')
    const sid = c.req.query('sid') ?? ''
    const ws = normalizeDir(decodeDir(c.req.query('ws') ?? ''))
    const ctx = requireSessionCtx(username, ws, sid)
    registry.touchSession(ctx)

    const lastEventId = Number.parseInt(c.req.header('Last-Event-ID') ?? '', 10)
    const lastSeq = Number.isNaN(lastEventId) ? null : lastEventId

    return streamSSE(c, async (stream) => {
      let closed = false
      let finish!: () => void
      const done = new Promise<void>((resolve) => {
        finish = resolve
      })

      const write = (event: string, data: string, id?: string): void => {
        if (closed) return
        stream.writeSSE({ ...(id ? { id } : {}), event, data }).catch(() => {
          closed = true
        })
      }

      /** 广播订阅回调：写帧 + query_closed 时终结流 */
      const send = (msg: SequencedEvent): void => {
        write(msg.event, JSON.stringify(msg.data), String(msg.seq))
        if (msg.event === 'query_closed') finish()
      }

      stream.onAbort(() => {
        closed = true
        finish()
      })

      // ① 重放（Last-Event-ID 增量；subscribe 与快照间无 await，单线程下原子无竞态）
      registry.subscribe(ctx, send)
      for (const msg of registry.eventsSince(ctx, lastSeq)) send(msg)

      // ② 挂起审批重放（不带 seq：前端按 toolCallId 幂等合并，不影响 Last-Event-ID 游标）
      for (const p of ctx.approvals.getPending()) {
        write('approval_request', JSON.stringify(p))
      }

      // ③ 心跳保活，直到 query_closed / 客户端断开
      const heartbeat = setInterval(() => {
        write('ping', '')
      }, SSE_HEARTBEAT_MS)
      try {
        await done
      } finally {
        clearInterval(heartbeat)
        registry.unsubscribe(ctx, send)
      }
    })
  })
}
