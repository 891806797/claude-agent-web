import { useEffect } from 'react'
import { Navigate, Outlet } from 'react-router-dom'
import { useAuthStore } from '@/stores/auth'

/**
 * 受保护路由的 layout 守卫。
 * - hydrate 未完成时渲染空，避免初始空 username 误跳 /login；
 * - 未登录重定向 /login；
 * - 否则渲染 <Outlet/>（子路由）。
 */
export function AuthGuard(): React.JSX.Element {
  const username = useAuthStore((s) => s.username)
  const initialized = useAuthStore((s) => s.initialized)
  const hydrate = useAuthStore((s) => s.hydrate)

  useEffect(() => {
    void hydrate()
  }, [hydrate])

  if (!initialized) return <></>
  if (!username) return <Navigate to="/login" replace />
  return <Outlet />
}
