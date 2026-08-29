import { agentService } from '@/modules/agent/agent.service'
import { authService } from '@/modules/auth/auth.service'

/**
 * admin 业务层 -- 管理端能力门面：聚合各业务模块的管理入口（逻辑单一来源，
 * 此处只做委托不做复制），未来 requireAdmin / 管理审计统一在此挂载。
 * 依赖方向：admin -> auth / agent（单向，无循环）。
 */
export const adminService = {
  /** 用户列表（管理页） */
  listUsers: () => authService.listUsers(),

  /** 重置用户 MFA（清绑定，用户需重新绑定） */
  resetUserMfa: (username: string) => authService.resetUserMfa(username),

  /** 运行看板统计 */
  getStats: () => agentService.getStats(),
}
