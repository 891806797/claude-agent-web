import { api, ApiError, withBase } from './api'
import type {
  ActiveSessionResult,
  ChatMessage,
  FileContent,
  MoveResult,
  Persona,
  Project,
  SessionSummary,
  SlashCommand,
  UploadResult
} from './agent-types'

/**
 * base64url 编码（UTF-8 安全）—— Windows 路径含中文/反斜杠/冒号，
 * HTTP header 仅 Latin-1、URL 明文不安全，线上传输一律编码。
 * 与后端 paths.ts decodeDir（Buffer base64url）对齐。
 */
export function encodeDir(dir: string): string {
  const bytes = new TextEncoder().encode(dir)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** 会话操作 header（POST/DELETE 类统一携带 x-session-id + x-workspace-dir） */
function sessionHeaders(sid: string, ws: string): Record<string, string> {
  return { 'x-session-id': sid, 'x-workspace-dir': encodeDir(ws) }
}

const BASE = '/api/agent'

export const agentApi = {
  // ---- 项目 ----
  listProjects: () => api.get<Project[]>(`${BASE}/projects`),
  createProject: (name: string, path: string) =>
    api.post<Project>(`${BASE}/projects`, { name, path }),
  removeProject: (id: string) => api.delete<void>(`${BASE}/projects/${id}`),

  // ---- 会话开启 / 接入 ----
  listSessions: (projectId: string, page = 1, pageSize = 20) =>
    api.get<SessionSummary[]>(
      `${BASE}/sessions?projectId=${projectId}&page=${page}&pageSize=${pageSize}`
    ),
  getActiveSession: (ws: string) =>
    api.get<ActiveSessionResult>(`${BASE}/sessions/active?ws=${encodeDir(ws)}`),
  openSession: (body: {
    projectId: string
    resumeSessionId?: string
    firstMessage?: string
    /** 新会话选定的智能体 id（append 系统提示词）；缺省 = 标准 Claude。resume 不传（后端按绑定快照回填） */
    personaId?: string
    evict?: boolean
  }) =>
    api.post<{ sessionId: string; workspaceDir: string; evicted?: boolean }>(
      `${BASE}/sessions`,
      body
    ),

  // ---- 会话操作（header 协议）----
  getMessages: (sid: string, ws: string) =>
    api.get<ChatMessage[]>(`${BASE}/session/messages`, { headers: sessionHeaders(sid, ws) }),
  sendMessage: (
    sid: string,
    ws: string,
    body: { text: string; images?: Array<{ dataUrl: string; mime: string }> }
  ) =>
    api.post<{ queued: boolean }>(`${BASE}/session/messages`, body, {
      headers: sessionHeaders(sid, ws)
    }),
  interrupt: (sid: string, ws: string) =>
    api.post<void>(`${BASE}/session/interrupt`, undefined, { headers: sessionHeaders(sid, ws) }),
  approve: (
    sid: string,
    ws: string,
    body: {
      toolCallId: string
      allowed: boolean
      updatedInput?: Record<string, unknown>
      feedback?: string
      alwaysAllow?: boolean
    }
  ) => api.post<void>(`${BASE}/session/approvals`, body, { headers: sessionHeaders(sid, ws) }),
  closeSession: (sid: string, ws: string) =>
    api.post<void>(`${BASE}/session/close`, undefined, { headers: sessionHeaders(sid, ws) }),
  deleteSession: (sid: string, ws: string) =>
    api.delete<void>(`${BASE}/session`, { headers: sessionHeaders(sid, ws) }),
  renameSession: (sid: string, ws: string, title: string) =>
    api.post<void>(`${BASE}/session/rename`, { title }, { headers: sessionHeaders(sid, ws) }),
  rewind: (sid: string, ws: string, messageId: string) =>
    api.post<void>(`${BASE}/session/rewind`, { messageId }, { headers: sessionHeaders(sid, ws) }),
  /** 切换会话智能体（仅 idle 可切；服务端替换进程并同 sid resume，历史保留）；personaId null = 切回标准 Claude */
  switchPersona: (sid: string, ws: string, personaId: string | null) =>
    api.put<{ sessionId: string; workspaceDir: string }>(
      `${BASE}/session/persona`,
      { personaId },
      {
        headers: sessionHeaders(sid, ws)
      }
    ),

  // ---- 智能体定义 ----
  listPersonas: () => api.get<Persona[]>(`${BASE}/personas`),
  createPersona: (body: { name: string; description: string; systemPrompt: string }) =>
    api.post<Persona>(`${BASE}/personas`, body),
  updatePersona: (
    id: string,
    body: Partial<{ name: string; description: string; systemPrompt: string }>
  ) => api.put<Persona>(`${BASE}/personas/${id}`, body),
  removePersona: (id: string) => api.delete<void>(`${BASE}/personas/${id}`),

  // ---- 探测 ----
  getCommands: (projectId: string) =>
    api.get<SlashCommand[]>(`${BASE}/commands?projectId=${projectId}`),
  /** all=true 返回全量（≤2000，文件树轮询用）；默认按 q 过滤取前 30（@mention 用） */
  getFiles: (projectId: string, q: string, all = false) =>
    api.get<string[]>(
      `${BASE}/files?projectId=${projectId}&q=${encodeURIComponent(q)}${all ? '&all=true' : ''}`
    ),

  // ---- 文件在线编辑 ----
  getFileContent: (projectId: string, path: string) =>
    api.get<FileContent>(`${BASE}/file?projectId=${projectId}&path=${encodeURIComponent(path)}`),
  saveFileContent: (projectId: string, path: string, content: string) =>
    api.put<{ path: string; size: number }>(`${BASE}/file`, { projectId, path, content }),

  // ---- 文件管理（工具栏 + 右键菜单；文件与目录统一入口） ----
  createFile: (projectId: string, path: string, content = '') =>
    api.post<{ path: string; size: number }>(`${BASE}/file`, { projectId, path, content }),
  createDir: (projectId: string, path: string) =>
    api.post<{ path: string }>(`${BASE}/dir`, { projectId, path }),
  /** 删除文件或目录（目录递归删除，不可恢复） */
  deleteEntry: (projectId: string, path: string) =>
    api.delete<void>(`${BASE}/file?projectId=${projectId}&path=${encodeURIComponent(path)}`),
  /** 移动/重命名（目标父目录不存在自动创建） */
  moveEntry: (projectId: string, from: string, to: string) =>
    api.post<MoveResult>(`${BASE}/file/move`, { projectId, from, to }),
  /** 批量上传（前端转 base64 走 JSON；单个 ≤1MB、≤10 个） */
  uploadFiles: (
    projectId: string,
    dir: string,
    files: Array<{ name: string; contentBase64: string }>
  ) => api.post<UploadResult>(`${BASE}/file/upload`, { projectId, dir, files }),

  /** SSE 端点 URL（EventSource 不支持自定义 header，sid/ws 走 query；
   *  EventSource 不经过 api.request，前缀需显式 withBase） */
  eventsUrl: (sid: string, ws: string) =>
    withBase(`${BASE}/session/events?sid=${sid}&ws=${encodeDir(ws)}`)
}

export { ApiError }
