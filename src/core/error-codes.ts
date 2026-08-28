/**
 * 全项目错误码唯一登记处。
 * 新增业务错误码：在下方追加一条，命名规则 `模块_原因`（大写下划线）。
 * 这是 AI 允许修改 core/ 的唯一白名单入口（只允许追加，禁止修改/删除既有条目）。
 */
export const ErrorCodes = {
  // ---- 通用 ----
  INTERNAL_ERROR: { status: 500, message: '服务器内部错误' },
  VALIDATION_ERROR: { status: 422, message: '请求参数校验失败' },
  NOT_FOUND: { status: 404, message: '资源不存在' },
  METHOD_NOT_ALLOWED: { status: 405, message: 'HTTP 方法不允许' },
  CONFLICT: { status: 409, message: '资源冲突' },
  // ---- article 模块 ----
  ARTICLE_NOT_FOUND: { status: 404, message: '文章不存在' },
} as const satisfies Record<string, { status: number; message: string }>

export type ErrorCode = keyof typeof ErrorCodes
