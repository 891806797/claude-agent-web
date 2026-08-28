import { create } from 'zustand'
import { getReady } from '@/lib/api'

interface SystemState {
  /** 就绪检查是否通过（数据库连接正常） */
  ready: boolean
  /** 是否正在请求 */
  loading: boolean
  /** 拉取 /readyz；成功返回 true，失败返回 false */
  fetchReady: () => Promise<boolean>
}

export const useSystemStore = create<SystemState>((set) => ({
  ready: false,
  loading: false,
  fetchReady: async () => {
    set({ loading: true })
    try {
      await getReady()
      set({ ready: true, loading: false })
      return true
    } catch (err) {
      console.error('fetchReady failed', err)
      set({ ready: false, loading: false })
      return false
    }
  }
}))
