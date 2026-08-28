import { z } from '@hono/zod-openapi'
import type { ErrorHandler } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { AppError } from '../app-error'
import { log } from '../logger'
import type { AppEnv } from '../types'

/**
 * 全局错误处理（app.onError 注册）—— 业务代码永远不写 try-catch 样板。
 *
 * 分工：zod 校验错误由 create-app 的 defaultHook 转 422（正常路径），
 * 此处仅兜底；业务错误 throw AppError；未知错误统一 INTERNAL_ERROR（不泄漏内部细节）。
 */
export const errorHandler: ErrorHandler<AppEnv> = (err, c) => {
  const traceId = c.get('traceId')

  // 1. 业务错误：查注册表得 status，4xx 记 warn、5xx 记 error
  if (AppError.is(err)) {
    log()[err.status >= 500 ? 'error' : 'warn']({ err, code: err.code }, err.message)
    return c.json(
      { error: { code: err.code, message: err.message, traceId, details: err.details } },
      err.status as ContentfulStatusCode,
    )
  }

  // 2. zod 错误兜底（正常路径走 defaultHook）
  if (err instanceof z.ZodError) {
    log().warn({ err: z.treeifyError(err) }, '请求参数校验失败')
    return c.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: '请求参数校验失败',
          traceId,
          details: z.treeifyError(err),
        },
      },
      422,
    )
  }

  // 3. postgres 唯一约束冲突 -> 409
  if (typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505') {
    log().warn({ err }, '唯一约束冲突')
    return c.json({ error: { code: 'CONFLICT', message: '资源冲突', traceId } }, 409)
  }

  // 4. hono 内部异常（如路由方法不匹配）
  if (err instanceof HTTPException) {
    const code =
      err.status === 404
        ? 'NOT_FOUND'
        : err.status === 405
          ? 'METHOD_NOT_ALLOWED'
          : 'INTERNAL_ERROR'
    log().warn({ err }, err.message)
    return c.json(
      { error: { code, message: err.message, traceId } },
      err.status as ContentfulStatusCode,
    )
  }

  // 5. 未知错误：日志留全量（含堆栈），响应不泄漏内部细节
  log().error({ err }, '未处理异常')
  return c.json({ error: { code: 'INTERNAL_ERROR', message: '服务器内部错误', traceId } }, 500)
}
