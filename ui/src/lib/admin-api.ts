import { api } from './api'
import type { StatsData } from './agent-types'

/** admin 域 API（管理端：用户档案/看板统计） */

/** 用户档案（管理列表；不含密码/MFA secret） */
export interface UserSummary {
  username: string
  mfaBoundAt: string | null
  lastLoginAt: string | null
  createdAt: string
}

export const adminApi = {
  listUsers: () => api.get<UserSummary[]>('/api/admin/users'),
  resetUserMfa: (username: string) =>
    api.post<void>(`/api/admin/users/${encodeURIComponent(username)}/reset-mfa`),
  getStats: () => api.get<StatsData>('/api/admin/stats')
}
