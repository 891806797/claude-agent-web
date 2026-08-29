import { Navigate, Route, Routes } from 'react-router-dom'
import { AuthGuard } from '@/components/AuthGuard'
import { AdminLayout } from '@/pages/admin/AdminLayout'
import { DashboardPage } from '@/pages/admin/DashboardPage'
import { PersonasPage } from '@/pages/admin/PersonasPage'
import { SettingsPage } from '@/pages/admin/SettingsPage'
import { ChatPage } from '@/pages/ChatPage'
import { LoginPage } from '@/pages/LoginPage'

/**
 * 路由表 -- 前端页面唯一登记处。新增页面：在 pages/ 建文件后在此加 Route。
 * 页面本体禁止写在本文件（见开发规范.md 第 12 节）。
 * 受保护页面用 AuthGuard（layout 路由）包裹；管理区 /admin/* 共用 AdminLayout。
 */
export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<AuthGuard />}>
        <Route path="/" element={<Navigate to="/chat" replace />} />
        <Route path="/chat" element={<ChatPage />} />
        <Route path="/admin" element={<AdminLayout />}>
          <Route index element={<Navigate to="dashboard" replace />} />
          <Route path="dashboard" element={<DashboardPage />} />
          <Route path="personas" element={<PersonasPage />} />
          <Route path="settings" element={<SettingsPage />} />
        </Route>
      </Route>
    </Routes>
  )
}
