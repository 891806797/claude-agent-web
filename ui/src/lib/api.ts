/**
 * 后端统一响应契约（见 src/core/response.ts）：
 *   成功 { data: T } / 失败 { error: { code, message, traceId } }
 */
interface ApiErrorBody {
  error: { code: string; message: string; traceId: string }
}

/** 统一错误体对应的错误类型：携带后端错误码与 traceId，便于排查对账 */
export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly traceId: string

  constructor(status: number, code: string, message: string, traceId: string) {
    super(message)
    this.status = status
    this.code = code
    this.traceId = traceId
    this.name = 'ApiError'
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init.headers }
  })
  if (!res.ok) {
    let code = 'HTTP_ERROR'
    let message = `请求失败 (${res.status})`
    let traceId = ''
    try {
      const body = (await res.json()) as Partial<ApiErrorBody>
      if (body.error) {
        code = body.error.code
        message = body.error.message
        traceId = body.error.traceId
      }
    } catch {
      // 非 JSON 响应体时保留默认消息
    }
    throw new ApiError(res.status, code, message, traceId)
  }
  const body = (await res.json()) as { data: T }
  return body.data
}

/** 类型化 API 客户端：JSON 进出、自动解包 data、非 2xx 抛 ApiError */
export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: 'POST',
      body: body === undefined ? undefined : JSON.stringify(body)
    }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: 'PUT',
      body: body === undefined ? undefined : JSON.stringify(body)
    }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' })
}

/** 就绪探针：后端返回 { data: 'ok' }，非 2xx 抛 ApiError */
export const getReady = () => api.get<string>('/readyz')
