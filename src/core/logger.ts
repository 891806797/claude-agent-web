import { AsyncLocalStorage } from 'node:async_hooks'
import pino, { type Logger } from 'pino'
import pretty from 'pino-pretty'
import { env, isDev } from '@/env'
import type { RequestContext } from './types'

/**
 * 日志核心：pino 根实例 + AsyncLocalStorage 请求上下文。
 *
 * 用法（业务代码唯一入口）：
 *   import { log, getLogger } from '@/core/logger'
 *   log().info({ articleId }, '文章已创建')   // 请求内自动携带 traceId
 *   getLogger('server').info('listening')     // 非请求场景（启动/定时任务等）
 *
 * 注意：bun 下禁止使用 pino.transport()（worker_threads 兼容问题），
 * 开发环境直接把 pino-pretty 实例作为 stream 传入。
 */
export const requestContextStorage = new AsyncLocalStorage<RequestContext>()

export const rootLogger: Logger = pino(
  {
    level: env.LOG_LEVEL,
    redact: {
      // 递归脱敏任意层级下的敏感字段（含 LOG_BODY 记录的请求体）
      paths: ['**.password', '**.token', '**.authorization', '**.secret', '**.accessKey'],
      censor: '[REDACTED]',
    },
  },
  isDev
    ? pretty({ colorize: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname' })
    : undefined,
)

/** 当前请求的 logger（自动携带 traceId）；请求上下文之外回退到根 logger */
export function log(): Logger {
  return requestContextStorage.getStore()?.logger ?? rootLogger
}

/** 模块级命名 logger：非请求场景（启动日志、后台任务）使用 */
export function getLogger(name: string): Logger {
  return rootLogger.child({ module: name })
}
