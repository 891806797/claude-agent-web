/**
 * 后端统一响应契约（见 src/core/response.ts）：
 *   成功 { data: T } / 失败 { error: { code, message, traceId, details? } }
 */
interface ApiErrorBody {
  error: { code: string; message: string; traceId: string; details?: unknown }
}

/** 统一错误体对应的错误类型：携带后端错误码与 traceId，便于排查对账 */
export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly traceId: string
  /** 后端附加信息（如 AGENT_SESSION_BUSY 的 occupiedBy），供 UI 细分处理 */
  readonly details?: unknown

  constructor(status: number, code: string, message: string, traceId: string, details?: unknown) {
    super(message)
    this.status = status
    this.code = code
    this.traceId = traceId
    this.details = details
    this.name = 'ApiError'
  }
}

/** 子路径部署前缀（vite base，根部署为 '/'，子路径如 '/claude/'——恒带尾斜杠）。
 *  与 vite.config.ts 的 base 同源（BASE_URL 环境变量），SSE/接口 URL 统一在此拼接。 */
export function withBase(path: string): string {
  const base = import.meta.env.BASE_URL ?? '/'
  return `${base}${path.slice(1)}`
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(withBase(path), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init.headers }
  })
  if (!res.ok) {
    let code = 'HTTP_ERROR'
    let message = `请求失败 (${res.status})`
    let traceId = ''
    let details: unknown
    try {
      const body = (await res.json()) as Partial<ApiErrorBody>
      if (body.error) {
        code = body.error.code
        message = body.error.message
        traceId = body.error.traceId
        details = body.error.details
      }
    } catch {
      // 非 JSON 响应体时保留默认消息
    }
    throw new ApiError(res.status, code, message, traceId, details)
  }
  // 204 No Content（如删除接口）无 body，res.json() 会抛 SyntaxError，直接返回空
  if (res.status === 204) return undefined as T
  const body = (await res.json()) as { data: T }
  return body.data
}

/** 类型化 API 客户端：JSON 进出、自动解包 data、非 2xx 抛 ApiError。
 *  可选 init 用于注入自定义 header（如 agent 会话操作的 x-session-id）。 */
export const api = {
  get: <T>(path: string, init?: RequestInit) => request<T>(path, init),
  post: <T>(path: string, body?: unknown, init?: RequestInit) =>
    request<T>(path, {
      method: 'POST',
      body: body === undefined ? undefined : JSON.stringify(body),
      ...init
    }),
  put: <T>(path: string, body?: unknown, init?: RequestInit) =>
    request<T>(path, {
      method: 'PUT',
      body: body === undefined ? undefined : JSON.stringify(body),
      ...init
    }),
  delete: <T>(path: string, init?: RequestInit) => request<T>(path, { method: 'DELETE', ...init })
}
