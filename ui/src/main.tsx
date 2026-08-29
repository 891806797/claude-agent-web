import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { Toaster } from '@/components/ui/sonner'
import './assets/main.css'

// 子路径部署（vite base，如 '/claude/'）时路由挂到对应 basename 下；根部署为 '/'
const routerBasename = import.meta.env.BASE_URL.replace(/\/+$/, '') || undefined

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter basename={routerBasename}>
      <App />
      <Toaster />
    </BrowserRouter>
  </StrictMode>
)
