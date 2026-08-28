import { Route, Routes } from 'react-router-dom'
import { HomePage } from '@/pages/home'

/**
 * 路由表 —— 前端页面唯一登记处。新增页面：在 pages/ 建文件后在此加 Route。
 * 页面本体禁止写在本文件（见开发规范.md 第 12 节）。
 */
export default function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
    </Routes>
  )
}
