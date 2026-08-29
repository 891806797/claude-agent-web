import { NavLink, Outlet } from 'react-router-dom'
import { ArrowLeft, Bot, LayoutDashboard, Settings } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * 管理区公共布局：左侧菜单导航 + 右侧内容区（/admin/* 全部页面共用）。
 * 第一个 menu 是运行看板；新增管理页在 MENU 登记即可。
 * 响应式：md+ 固定左侧竖栏；小屏同一导航折叠为顶部横向条（可横滚，零状态无抽屉）。
 */
const MENU = [
  { to: 'dashboard', label: '看板', icon: LayoutDashboard },
  { to: 'personas', label: '智能体', icon: Bot },
  { to: 'settings', label: '设置', icon: Settings }
] as const

export function AdminLayout(): React.JSX.Element {
  return (
    <div className="flex min-h-screen flex-col bg-background md:flex-row">
      <aside className="shrink-0 border-b bg-card/60 md:w-52 md:border-b-0 md:border-r">
        <nav className="flex items-center gap-1 overflow-x-auto p-3 md:flex-col md:items-stretch md:gap-1 md:p-3">
          <span className="mr-2 shrink-0 self-center text-base font-semibold text-foreground md:mb-3 md:mr-0 md:px-2 md:text-lg">
            管理
          </span>
          {MENU.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                cn(
                  'flex shrink-0 items-center gap-2 rounded-md px-3 py-1.5 text-sm whitespace-nowrap transition-colors',
                  isActive
                    ? 'bg-primary/10 font-medium text-primary'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                )
              }
            >
              <Icon className="size-4 shrink-0" />
              {label}
            </NavLink>
          ))}
          <a
            href="/chat"
            className="mt-1 flex shrink-0 items-center gap-2 rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground md:mt-auto md:px-3"
          >
            <ArrowLeft className="size-4 shrink-0" />
            返回聊天
          </a>
        </nav>
      </aside>
      {/* 内容区：页面自带 main（DashboardPage/SettingsPage），此处仅承载与撑满 */}
      <div className="min-w-0 flex-1">
        <Outlet />
      </div>
    </div>
  )
}
