import type { MiddlewareHandler } from 'hono'
import { env } from '@/env'
import { log } from '../logger'
import type { AppEnv } from '../types'

/** 请求体日志截断长度 */
const MAX_BODY_LOG_LENGTH = 2048

/**
 * 访问日志中间件：每请求恰好一条汇总日志，字段齐全可直接过滤定位问题。
 *
 *   traceId | method | path | query | status | durationMs | ip | userAgent
 *
 * LOG_BODY=true 时追加记录请求体（截断 2KB，敏感字段由 pino redact 脱敏）。
 * 错误详情（堆栈）由 error-handler 负责，此处不重复记录。
 */
export function accessLog(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const start = performance.now()
    await next()
    const durationMs = Number((performance.now() - start).toFixed(1))

    const fields: Record<string, unknown> = {
      method: c.req.method,
      path: c.req.path,
      query: c.req.query() ?? {},
      status: c.res.status,
      durationMs,
      ip: c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown',
      userAgent: c.req.header('user-agent'),
    }

    if (env.LOG_BODY) {
      fields.body = await readRequestBodyForLog(c)
    }

    // 5xx 提升到 error 级别便于告警，其余 info
    log()[c.res.status >= 500 ? 'error' : 'info']({ req: fields }, 'access')
  }
}

/** 读取请求体用于日志：hono 会缓存 body，不影响后续 c.req.valid('json')；非 JSON 安全返回 undefined */
async function readRequestBodyForLog(
  c: Parameters<MiddlewareHandler<AppEnv>>[0],
): Promise<string | undefined> {
  if (!c.req.raw.body) {
    return undefined
  }
  try {
    const parsed = await c.req.json()
    return truncate(JSON.stringify(redactSensitive(parsed)))
  } catch {
    return '[unparseable body]'
  }
}

/** 敏感字段键名（小写比较）——序列化前主动遮蔽（pino redact 无法进入字符串形式的 body） */
const SENSITIVE_KEYS = new Set(['password', 'token', 'authorization', 'secret', 'accesskey'])

function redactSensitive(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactSensitive)
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, val]) => [
        key,
        SENSITIVE_KEYS.has(key.toLowerCase()) ? '[REDACTED]' : redactSensitive(val),
      ]),
    )
  }
  return value
}

function truncate(text: string): string {
  return text.length > MAX_BODY_LOG_LENGTH
    ? `${text.slice(0, MAX_BODY_LOG_LENGTH)}...[truncated]`
    : text
}
