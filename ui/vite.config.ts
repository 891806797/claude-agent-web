import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    },
    // 强制单一 React 实例，避免嵌套依赖导致 Invalid hook call
    dedupe: ['react', 'react-dom']
  },
  server: {
    port: 5173,
    strictPort: true,
    // 开发期代理到后端 bun/hono 服务（生产前端由可执行文件内嵌服务，同源直连）
    proxy: {
      '/api': 'http://localhost:3000',
      '/readyz': 'http://localhost:3000',
      '/healthz': 'http://localhost:3000',
      '/openapi.json': 'http://localhost:3000',
      '/docs': 'http://localhost:3000'
    }
  }
})
