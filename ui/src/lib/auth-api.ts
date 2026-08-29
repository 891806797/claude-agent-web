import { api } from './api'

/** auth 域 API（用户管理；不含密码/secret） */
export interface UserSummary {
  username: string
  mfaBoundAt: string | null
  lastLoginAt: string | null
  createdAt: string
}

export const authApi = {
  listUsers: () => api.get<UserSummary[]>('/api/auth/users'),
  resetUserMfa: (username: string) =>
    api.post<void>(`/api/auth/users/${encodeURIComponent(username)}/reset-mfa`)
}
