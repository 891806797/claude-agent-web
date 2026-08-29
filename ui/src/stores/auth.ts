import { create } from 'zustand'
import { api } from '@/lib/api'

/**
 * 登录态（zustand 范式）。
 * JWT 存 HttpOnly cookie（前端不可读），store 只保存「已登录用户名」，
 * 真伪以 GET /api/auth/me 为准。
 */
interface AuthState {
  /** 当前登录用户名（空串 = 未登录） */
  username: string
  /** 启动 hydrate 是否完成（未完成前守卫不跳转，避免初始空 username 误跳 /login） */
  initialized: boolean
  /** MFA 通过后（cookie 已由服务端签发）记录登录态 */
  setLoggedIn: (username: string) => void
  /** 启动时校验 cookie 登录态；401 视为未登录（不抛错） */
  hydrate: () => Promise<void>
  /** 登出：POST /api/auth/logout（服务端关会话+拉黑 token+清 cookie）并清本地态 */
  logout: () => Promise<void>
}

export const useAuthStore = create<AuthState>((set) => ({
  username: '',
  initialized: false,
  setLoggedIn: (username) => set({ username, initialized: true }),
  hydrate: async () => {
    try {
      const me = await api.get<{ username: string }>('/api/auth/me')
      set({ username: me.username, initialized: true })
    } catch {
      // 未登录 / cookie 失效 -> 清空登录态（守卫按空 username 跳 /login）
      set({ username: '', initialized: true })
    }
  },
  logout: async () => {
    try {
      await api.post('/api/auth/logout')
    } catch {
      // 登出接口失败不阻断本地清态（cookie 可能已失效）
    }
    set({ username: '' })
  }
}))
