import { AsyncLocalStorage } from 'node:async_hooks'
import {
  createWriteStream,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  type WriteStream,
} from 'node:fs'
import { join } from 'node:path'
import pino, { type Logger } from 'pino'
import pretty from 'pino-pretty'
import { env, isDev } from '@/env'
import type { RequestContext } from './types'

/**
 * 日志核心：pino 根实例 + AsyncLocalStorage 请求上下文 + 按天滚动文件。
 *
 * 用法（业务代码唯一入口）：
 *   import { log, getLogger } from '@/core/logger'
 *   log().info({ sessionId }, '会话已开启')   // 请求内自动携带 traceId
 *   getLogger('server').info('listening')     // 非请求场景（启动/定时任务等）
 *
 * 文件输出：{LOG_DIR}/console-YYYY-MM-DD.log 按天滚动（用户需求；bun 下禁用
 * pino.transport()（worker_threads 兼容问题），故手写滚动流）；dev 下与
 * pino-pretty stdout 双写。启动时按 LOG_RETENTION_DAYS 清理过期文件。
 */

/**
 * 按天滚动的日志文件流：write 时检查本地日期，跨天自动切换文件句柄（追加模式）。
 * 实现 pino stream 协议（仅 write），flush/close 由进程退出兜底（append 模式丢帧风险极低）。
 */
class DailyRollingFileStream {
  private stream: WriteStream | null = null
  private currentDay = ''

  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true })
  }

  write(line: string): void {
    const day = localDay()
    if (day !== this.currentDay) {
      this.stream?.end()
      this.currentDay = day
      this.stream = createWriteStream(join(this.dir, `console-${day}.log`), { flags: 'a' })
    }
    this.stream?.write(line)
  }
}

/** 本地时区日期字符串（YYYY-MM-DD） */
function localDay(date = new Date()): string {
  const y = date.getFullYear()
  const m = `${date.getMonth() + 1}`.padStart(2, '0')
  const d = `${date.getDate()}`.padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** 启动时清理超过保留天数的日志文件（失败仅告警，不影响启动） */
export function cleanupOldLogFiles(): void {
  const cutoff = Date.now() - env.LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000
  const logger = rootLogger.child({ module: 'logger' })
  try {
    for (const name of readdirSync(env.LOG_DIR)) {
      if (!/^console-\d{4}-\d{2}-\d{2}\.log$/.test(name)) continue
      const path = join(env.LOG_DIR, name)
      if (statSync(path).mtimeMs < cutoff) {
        unlinkSync(path)
        logger.info({ path }, '已清理过期日志文件')
      }
    }
  } catch (err) {
    logger.warn({ err }, '清理过期日志文件失败（目录不存在或不可读）')
  }
}

const fileStream = new DailyRollingFileStream(env.LOG_DIR)
const prettyStream = pretty({
  colorize: true,
  translateTime: 'SYS:HH:MM:ss.l',
  ignore: 'pid,hostname',
})

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
    ? {
        // dev：pretty stdout + 按天文件双写
        write(line: string) {
          prettyStream.write(line)
          fileStream.write(line)
        },
      }
    : fileStream,
)

/** 当前请求的 logger（自动携带 traceId）；请求上下文之外回退到根 logger */
export function log(): Logger {
  return requestContextStorage.getStore()?.logger ?? rootLogger
}

/** 模块级命名 logger：非请求场景（启动日志、后台任务）使用 */
export function getLogger(name: string): Logger {
  return rootLogger.child({ module: name })
}
