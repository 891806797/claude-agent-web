import { z } from '@hono/zod-openapi'
import type { AgentPersonaRow, AgentProjectRow } from './agent.table'

/**
 * agent 模块的 zod DTO —— 请求校验、TS 类型、OpenAPI 文档的唯一真源。
 * 注意：z 一律从 '@hono/zod-openapi' 导入（带 .openapi() 扩展），禁止从 'zod' 导入。
 */

// ===== 项目 =====

export const CreateProjectInput = z.object({
  name: z.string().min(1).max(100).openapi({ example: 'claude-agent-web' }),
  /** 项目绝对路径（服务端归一化 + 白名单校验） */
  path: z.string().min(2).max(500).openapi({ example: 'D:/worker/projects/demo' }),
})

export const ProjectDto = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    /** 归一化路径（正斜杠小写，registry 主键口径） */
    path: z.string(),
    createdBy: z.string(),
    createdAt: z.iso.datetime(),
  })
  .openapi('AgentProject')

export type Project = z.infer<typeof ProjectDto>
export type CreateProjectData = z.infer<typeof CreateProjectInput>

export const toProject = (row: AgentProjectRow): Project => ({
  id: row.id,
  name: row.name,
  path: row.path,
  createdBy: row.createdBy,
  createdAt: row.createdAt.toISOString(),
})

// ===== 智能体定义 =====

export const CreatePersonaInput = z.object({
  name: z.string().min(1).max(50).openapi({ example: '代码审查专员' }),
  description: z.string().max(500).openapi({ example: '专注代码质量与缺陷审查' }),
  /** 追加到 claude_code 预设后的系统提示词（原文注入，不自动包装） */
  systemPrompt: z.string().min(1).max(50000).openapi({ example: '你是一名严谨的代码审查员……' }),
})

export const UpdatePersonaInput = CreatePersonaInput.partial()

export const PersonaDto = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    description: z.string(),
    systemPrompt: z.string(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .openapi('AgentPersona')

export type Persona = z.infer<typeof PersonaDto>
export type CreatePersonaData = z.infer<typeof CreatePersonaInput>
export type UpdatePersonaData = z.infer<typeof UpdatePersonaInput>

export const toPersona = (row: AgentPersonaRow): Persona => ({
  id: row.id,
  name: row.name,
  description: row.description,
  systemPrompt: row.systemPrompt,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
})

// ===== 会话操作 header 协议 =====

/**
 * 会话操作协议：POST 类接口统一携带 x-session-id + x-workspace-dir（base64url）。
 * header 仅 Latin-1，Windows 路径含中文/反斜杠必须编码；SSE 端点走 query（EventSource 无自定义 header）。
 */
export const SessionHeaders = z.object({
  'x-session-id': z.string().uuid(),
  'x-workspace-dir': z.string().regex(/^[A-Za-z0-9_-]+$/, 'base64url 编码的工作目录'),
})

// ===== 会话开启 =====

export const OpenSessionInput = z.object({
  /** 项目 id 必填：workspaceDir 由项目表反查（path 即白名单边界，新开/resume 同口径） */
  projectId: z.string().uuid(),
  /** resume：续接历史会话 id（缺省 = 新会话） */
  resumeSessionId: z.string().uuid().optional(),
  /** 开会话即发首条消息（新会话常用；SDK init 需 user message 才产出 session_id 之外的内容） */
  firstMessage: z.string().max(50000).optional(),
  /** 自定义智能体 id：新会话选定 persona（append 系统提示词）；缺省 = 标准 Claude */
  personaId: z.string().uuid().optional(),
  /** 同目录被自己占用时原子关旧开新（切换确认后携带） */
  evict: z.boolean().optional(),
})

export const OpenSessionResult = z.object({
  sessionId: z.string().uuid(),
  /** 归一化 workspaceDir（前端 URL/localStorage 后续请求都用它） */
  workspaceDir: z.string(),
  /** 本次 open 是否走了 evict 切换 */
  evicted: z.boolean().optional(),
})

export type OpenSessionData = z.infer<typeof OpenSessionInput>

// ===== 会话切换智能体 =====

/** personaId 传 null（或缺省）= 切回标准 Claude（删除绑定） */
export const SwitchPersonaInput = z.object({
  personaId: z
    .string()
    .uuid()
    .nullable()
    .openapi({ example: null, description: '目标智能体 id；null = 标准 Claude' }),
})

export type SwitchPersonaData = z.infer<typeof SwitchPersonaInput>

// ===== 发消息 =====

export const SendMessageInput = z.object({
  text: z.string().min(1).max(50000).openapi({ example: '帮我看看这个报错' }),
  /** 图片附件（dataUrl，M3 前端接入；后端透传 SDK image block） */
  images: z
    .array(
      z.object({
        dataUrl: z.string().startsWith('data:'),
        mime: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
      }),
    )
    .max(5)
    .optional(),
})

export type SendMessageData = z.infer<typeof SendMessageInput>

// ===== 审批 =====

export const ApprovalInput = z.object({
  toolCallId: z.string().min(1),
  allowed: z.boolean(),
  /** 允许时修改命令（白名单：仅 Bash/PowerShell 的 command 字段） */
  updatedInput: z.record(z.string(), z.unknown()).optional(),
  /** 拒绝理由 */
  feedback: z.string().max(2000).optional(),
  /** 本次会话对该工具总是允许 */
  alwaysAllow: z.boolean().optional(),
})

export type ApprovalData = z.infer<typeof ApprovalInput>

// ===== 占用信息（409 响应附带）=====

export const OccupiedInfo = z.object({
  username: z.string(),
  sessionId: z.string(),
  state: z.string(),
  /** 已空闲分钟数（供等待方预估自动释放时间） */
  idleMinutes: z.number(),
})

export type OccupiedInfoData = z.infer<typeof OccupiedInfo>

// ===== 响应 DTO（wire 形状与 sse-events.ts 的 TS 类型保持同构）=====

export const SessionSummaryDto = z
  .object({
    id: z.string(),
    summary: z.string(),
    title: z.string(),
    lastModified: z.number(),
    gitBranch: z.string(),
    cwd: z.string(),
    fileSize: z.number(),
    createdAt: z.number(),
    live: z.boolean().openapi({ example: false, description: '会话当前存活（有活跃进程）' }),
    /** 会话绑定的智能体名快照（无绑定则缺省 = 标准 Claude） */
    personaName: z.string().optional(),
  })
  .openapi('AgentSession')

/** 枚举与 session-registry 的 SessionState 字面量集保持一致 */
export const SessionStateEnum = z.enum(['starting', 'idle', 'turn-running', 'closing', 'closed'])

export const ActiveSessionDto = z
  .object({
    sessionId: z.string(),
    state: SessionStateEnum,
    startedAt: z.number().openapi({ description: 'epoch ms' }),
    turns: z.number(),
    /** 会话绑定的智能体 id（绑定快照事实源；无绑定则缺省 = 标准 Claude） */
    personaId: z.string().uuid().optional(),
    /** 绑定名快照（persona 事后增删改不影响此值） */
    personaName: z.string().optional(),
    /** 会话当前生效的 append 系统提示词（最后切换值；标准 Claude 缺省） */
    systemPrompt: z.string().optional(),
  })
  .openapi('AgentActiveSession')

export const ActiveSessionResult = z.object({
  /** 本人活跃会话（attach 入口）；他人占用时为 null 并附 occupiedBy */
  active: ActiveSessionDto.nullable(),
  occupiedBy: OccupiedInfo.optional(),
})

export const SendMessageResult = z.object({ queued: z.boolean() })

export const ContentBlockDto = z.union([
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('thinking'), text: z.string() }),
  z.object({
    type: z.literal('tool_use'),
    id: z.string(),
    name: z.string(),
    input: z.record(z.string(), z.unknown()),
    result: z.string().optional(),
    resultError: z.boolean().optional(),
    toolUseResult: z.unknown().optional(),
  }),
])

export const ChatMessageDto = z
  .union([
    z.object({ type: z.literal('user'), id: z.string(), content: z.string() }),
    z.object({
      type: z.literal('assistant'),
      id: z.string(),
      content: z.array(ContentBlockDto),
      partial: z.boolean().optional(),
    }),
    z.object({
      type: z.literal('system'),
      id: z.string(),
      content: z.string(),
      level: z.enum(['interrupt', 'error', 'info']).optional(),
    }),
    z.object({
      type: z.literal('compaction'),
      id: z.string(),
      trigger: z.enum(['manual', 'auto']),
      preTokens: z.number(),
    }),
  ])
  .openapi('AgentChatMessage')

export const SlashCommandDto = z
  .object({
    name: z.string(),
    description: z.string(),
    argumentHint: z.string(),
    aliases: z.array(z.string()).optional(),
  })
  .openapi('AgentSlashCommand')

export const RenameSessionInput = z.object({ title: z.string().min(1).max(200) })

// ===== 看板统计 =====

export const StatsDto = z
  .object({
    active: z.object({
      sessions: z.number(),
      users: z.number(),
      byState: z.record(z.string(), z.number()),
      byUser: z.array(z.object({ username: z.string(), count: z.number() })),
      inputTokens: z.number(),
      outputTokens: z.number(),
    }),
    historical: z.object({
      totalSessions: z.number(),
      todaySessions: z.number(),
      totalInputTokens: z.number(),
      totalOutputTokens: z.number(),
      byCloseReason: z.record(z.string(), z.number()),
    }),
    projects: z.number(),
    registeredUsers: z.number(),
  })
  .openapi('AgentStats')

export type StatsData = z.infer<typeof StatsDto>

export const RewindInput = z.object({
  /** 回滚目标：某条 user message 的 uuid（checkpoint） */
  messageId: z.string().min(1),
})

// ===== 项目文件内容（双击在线编辑） =====

/** 在线编辑大小上限（读/写同限，字节口径；服务端按 utf8 字节数精确校验，这里字符数只做粗筛） */
export const MAX_EDITABLE_FILE_BYTES = 1_048_576

/**
 * 项目内相对路径协议（与 walkProjectFiles 输出对齐）：正斜杠、非空分段。
 * 禁绝 `/` 开头、`\\`、`..`/`.` 分段与 NUL —— 第一道防目录穿越（`.` 会 resolve 成
 * 项目根，配合删除/移动接口等于操作整个项目；service 端还有前缀校验兜底）。
 */
export const FilePathSchema = z
  .string()
  .min(1)
  .max(500)
  .refine(
    (p) =>
      !p.startsWith('/') &&
      !p.includes('\\') &&
      !p.includes('\0') &&
      p.split('/').every((seg) => seg !== '..' && seg !== '' && seg !== '.'),
    { message: '非法文件路径：仅支持项目内相对路径' },
  )

export const FileContentResult = z
  .object({
    path: z.string(),
    content: z.string(),
    size: z.number(),
  })
  .openapi('AgentFileContent')

export const SaveFileInput = z.object({
  projectId: z.string().uuid(),
  path: FilePathSchema,
  content: z.string().max(MAX_EDITABLE_FILE_BYTES),
})

export const SaveFileResult = z
  .object({
    path: z.string(),
    size: z.number(),
  })
  .openapi('AgentFileSaveResult')

export type FileContentData = z.infer<typeof FileContentResult>
export type SaveFileData = z.infer<typeof SaveFileInput>

// ===== 项目文件管理（工具栏上传/创建 + 右键删除/移动） =====

/** 目录相对路径：同 FilePathSchema 但允许空串（= 项目根） */
export const DirPathSchema = z.union([FilePathSchema, z.literal('')])

/** 含控制字符（码点 0x00-0x1f）——正则内联写法被 biome noControlCharactersInRegex 禁止，码点判断同义 */
function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) < 0x20) return true
  return false
}

/** 上传文件名（multipart 之外的传输层命名）：拒路径分隔/穿越/控制字符与 win32 保留字符 */
const UploadFileNameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (n) =>
      !n.includes('/') &&
      !n.includes('\\') &&
      !n.includes('\0') &&
      n !== '.' &&
      n !== '..' &&
      !/[<>:"|?*]/.test(n) &&
      !hasControlChar(n) &&
      !n.endsWith('.') &&
      !n.endsWith(' '),
    { message: '非法文件名' },
  )

export const CreateFileInput = z.object({
  projectId: z.string().uuid(),
  path: FilePathSchema,
  content: z.string().max(MAX_EDITABLE_FILE_BYTES).optional(),
})

export const CreateDirInput = z.object({
  projectId: z.string().uuid(),
  path: FilePathSchema,
})

export const MoveFileInput = z.object({
  projectId: z.string().uuid(),
  from: FilePathSchema,
  to: FilePathSchema,
})

export const UploadFilesInput = z.object({
  projectId: z.string().uuid(),
  /** 目标目录（项目内相对路径；缺省/空 = 项目根） */
  dir: DirPathSchema.optional(),
  files: z
    .array(
      z.object({
        name: UploadFileNameSchema,
        /** base64（UTF-8 安全；宽容 base64url 变体）；1MB 文件编码后约 1.4MB，上限放余量 */
        contentBase64: z
          .string()
          .min(1)
          .max(1_500_000)
          .regex(/^[A-Za-z0-9+/\-_]*={0,2}$/, '非法 base64 内容'),
      }),
    )
    .min(1)
    .max(10),
})

export const MoveFileResult = z
  .object({ from: z.string(), to: z.string() })
  .openapi('AgentFileMoveResult')

export const UploadFilesResult = z
  .object({ saved: z.array(z.string()) })
  .openapi('AgentFilesUploadResult')

export const CreateDirResult = z.object({ path: z.string() }).openapi('AgentDirCreateResult')

export type CreateFileData = z.infer<typeof CreateFileInput>
export type MoveFileData = z.infer<typeof MoveFileInput>
export type UploadFilesData = z.infer<typeof UploadFilesInput>
export type MoveFileResultData = z.infer<typeof MoveFileResult>
export type UploadFilesResultData = z.infer<typeof UploadFilesResult>
