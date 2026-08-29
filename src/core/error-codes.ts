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
  // ---- auth 模块 ----
  AUTH_FAILED: { status: 401, message: '用户名或密码错误' },
  AUTH_LOGIN_SERVICE_ERROR: { status: 502, message: '登录服务暂不可用，请稍后再试' },
  AUTH_LOCKED: { status: 423, message: '失败次数过多，账号已临时锁定' },
  UNAUTHORIZED: { status: 401, message: '未登录或登录已过期' },
  MFA_NOT_BOUND: { status: 400, message: '未绑定 MFA，请先绑定' },
  MFA_ALREADY_BOUND: { status: 409, message: '该账号已绑定 MFA' },
  MFA_TOKEN_INVALID: { status: 401, message: '动态码错误，请重新输入' },
  MFA_PENDING_EXPIRED: { status: 410, message: '绑定已过期，请刷新二维码重试' },
  // ---- agent 模块 ----
  AGENT_PROJECT_NOT_FOUND: { status: 404, message: '项目目录不存在或未注册' },
  AGENT_PROJECT_PATH_INVALID: { status: 422, message: '项目路径非法或目录不存在' },
  AGENT_PROJECT_PATH_EXISTS: { status: 409, message: '该路径已注册为项目' },
  AGENT_SESSION_NOT_FOUND: { status: 404, message: '会话不存在或未在活跃状态' },
  AGENT_SESSION_BUSY: { status: 409, message: '当前项目目录已有活跃会话' },
  AGENT_SESSION_LIMIT: { status: 409, message: '活跃会话数已达上限' },
  AGENT_SESSION_CLOSING: { status: 409, message: '会话正在关闭' },
  AGENT_APPROVAL_NOT_FOUND: { status: 409, message: '该审批已被处理' },
  AGENT_SDK_ERROR: { status: 500, message: 'Claude 会话启动失败' },
  AGENT_PERSONA_NOT_FOUND: { status: 404, message: '智能体不存在' },
  AGENT_PERSONA_NAME_EXISTS: { status: 409, message: '智能体名称已存在' },
  AGENT_PERSONA_SWITCH_BUSY: { status: 409, message: '会话忙碌，请在空闲时切换智能体' },
} as const satisfies Record<string, { status: number; message: string }>

export type ErrorCode = keyof typeof ErrorCodes
