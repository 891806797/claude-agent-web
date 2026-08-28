import { type ErrorCode, ErrorCodes } from './error-codes'

export interface AppErrorOptions {
  /** 覆盖注册表中的默认消息 */
  message?: string
  /** 附加信息（如字段级校验细节），会原样进入错误响应的 details 字段 */
  details?: unknown
  cause?: unknown
}

/**
 * 业务错误唯一表达方式。
 * HTTP 状态与默认消息由 core/error-codes.ts 注册表决定，业务层只关心 code：
 *
 *   throw new AppError('ARTICLE_NOT_FOUND')
 *   throw new AppError('CONFLICT', { message: '标题已存在', details: { title } })
 */
export class AppError extends Error {
  readonly code: ErrorCode
  readonly status: number
  readonly details?: unknown

  constructor(code: ErrorCode, options: AppErrorOptions = {}) {
    const preset = ErrorCodes[code]
    super(options.message ?? preset.message, { cause: options.cause })
    this.name = 'AppError'
    this.code = code
    this.status = preset.status
    this.details = options.details
  }

  /** 类型守卫：error-handler 中用于区分业务错误与未知错误 */
  static is(err: unknown): err is AppError {
    return err instanceof AppError
  }
}
