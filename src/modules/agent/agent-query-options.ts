import type { Options } from '@anthropic-ai/claude-agent-sdk'
import type { Logger } from 'pino'
import { env } from '@/env'
import { getCliPath } from './cli-path'
import { userConfigDir } from './user-config'

/**
 * SDK query() 的 options 基座（正式会话与零 token 探测共用同一套口径）。
 *
 * 铁律：
 * - 绝不传 allowedTools 裸内置工具名——SDK 会自动放行、完全绕过 canUseTool 审批
 * - settingSources 不含 'user'：不读服务器 ~/.claude（多人共用宿主机，避免串配置）
 * - env 注入用户级 CLAUDE_CONFIG_DIR + 网关变量：会话数据按用户物理隔离
 * - stderr 回调用 sessionLogger（会话级 logger 显式传递，脱离请求 ALS）
 */

/** SDK 未导出 CanUseTool 类型别名，从 Options 字段反取 */
export type CanUseToolFn = NonNullable<Options['canUseTool']>

export interface SessionQueryParams {
  username: string
  cwd: string
  /** 新会话预设 session id（CLI 2.x 首条用户消息前不发 init，预设 id 使 openSession 免等握手） */
  sessionId?: string
  model?: string
  resume?: string
  abortController: AbortController
  canUseTool: CanUseToolFn
  sessionLogger: Logger
}

/** 正式会话 options（streaming-input 常驻模式） */
export function buildSessionQueryOptions(params: SessionQueryParams): Options {
  return {
    ...baseOptions(params.username, params.cwd, params.sessionLogger),
    abortController: params.abortController,
    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
    ...(params.resume ? { resume: params.resume } : {}),
    ...(params.model ? { model: params.model } : {}),
    permissionMode: 'default',
    canUseTool: params.canUseTool,
  }
}

export interface ProbeQueryParams {
  username: string
  cwd?: string
  sessionLogger: Logger
}

/** 零 token 探测 options（supportedCommands/supportedModels 预取，无 canUseTool） */
export function buildProbeQueryOptions(params: ProbeQueryParams): Options {
  return baseOptions(params.username, params.cwd, params.sessionLogger)
}

function baseOptions(username: string, cwd: string | undefined, sessionLogger: Logger): Options {
  const cliPath = getCliPath()
  return {
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    cwd,
    settingSources: ['project', 'local'],
    includePartialMessages: true,
    agentProgressSummaries: true,
    // 注意：enableFileCheckpointing 在 streaming-input 模式下会让 CLI 等 stdin 首条 user message
    // 才发 SessionStart（实测空开会话 0 输出 45s 超时死锁）。rewindFiles 依赖它；若需回滚能力，
    // 须改为"带首条消息开会话"流程（对齐 desktop），暂禁用以保证会话可创建。
    // 编译版：显式指定解包后的 claude.exe 路径（dev 留空让 SDK 自解析）
    ...(cliPath ? { pathToClaudeCodeExecutable: cliPath } : {}),
    env: childEnv(username),
    stderr: (data: string): void => {
      sessionLogger.warn({ source: 'sdk-stderr' }, data.trimEnd())
    },
  }
}

/** 子进程 env：继承本进程（过滤 undefined）+ 用户级 CLAUDE_CONFIG_DIR + 网关透传 */
function childEnv(username: string): Record<string, string> {
  const e: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) e[k] = v
  }
  e.CLAUDE_CONFIG_DIR = userConfigDir(username)
  if (env.ANTHROPIC_BASE_URL) e.ANTHROPIC_BASE_URL = env.ANTHROPIC_BASE_URL
  if (env.ANTHROPIC_AUTH_TOKEN) e.ANTHROPIC_AUTH_TOKEN = env.ANTHROPIC_AUTH_TOKEN
  if (env.ANTHROPIC_MODEL) e.ANTHROPIC_MODEL = env.ANTHROPIC_MODEL
  return e
}
