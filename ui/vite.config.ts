import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// 子路径部署前缀（与后端共用同一 BASE_URL 变量，如 /claude）：
// 构建产物引用 /claude/assets/...，与 nginx 反代形态一致；未设置时根路径部署。
// vite base 要求首尾斜杠，环境变量允许 '/claude' 或 '/claude/'
const base = process.env.BASE_URL?.trim().replace(/\/+$/, '')
const viteBase = base ? `${base}/` : '/'

// https://vite.dev/config/
export default defineConfig({
  base: viteBase,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    },
    // 强制单一 React 实例，避免嵌套依赖导致 Invalid hook call
    dedupe: ['react', 'react-dom']
  },
  server: {
    port: 3001,
    strictPort: true,
    // 开发期代理到后端 bun/hono 服务（生产前端由可执行文件内嵌服务，同源直连）。
    // 设了 BASE_URL 时前端请求带 /claude 前缀，这里剥掉前缀转发给根路径的后端
    // （后端 dev 不设 BASE_URL），即可完整模拟生产的子路径形态。
    proxy: base
      ? {
          [`${base}/api`]: {
            target: 'http://localhost:3000',
            rewrite: (p) => p.slice(base.length) || '/'
          },
          [`${base}/readyz`]: {
            target: 'http://localhost:3000',
            rewrite: (p) => p.slice(base.length) || '/'
          },
          [`${base}/healthz`]: {
            target: 'http://localhost:3000',
            rewrite: (p) => p.slice(base.length) || '/'
          },
          [`${base}/openapi.json`]: {
            target: 'http://localhost:3000',
            rewrite: (p) => p.slice(base.length) || '/'
          },
          [`${base}/docs`]: {
            target: 'http://localhost:3000',
            rewrite: (p) => p.slice(base.length) || '/'
          }
        }
      : {
          '/api': 'http://localhost:3000',
          '/readyz': 'http://localhost:3000',
          '/healthz': 'http://localhost:3000',
          '/openapi.json': 'http://localhost:3000',
          '/docs': 'http://localhost:3000'
        }
  }
})
