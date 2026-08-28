import { existsSync } from 'node:fs'
import { posix } from 'node:path'
import type { App } from '@/core/types'

/**
 * 编译版前端静态服务。
 *
 * 打包脚本以 `bun build --compile --asset ./ui/dist` 把 vite 产物整体嵌入可执行文件，
 * bun 按目录 basename 挂载到 bunfs 根：import.meta.dir/dist（Bun.file / node:fs 可直读）。
 * 开发/测试模式（bun run dev / bun test）不经编译，前端由 vite dev server（5173）负责。
 */

// 编译版 import.meta.dir 为 bunfs 虚拟根；dev 下为 src/（无 dist，hasFrontend 为 false）
const FRONTEND_DIR = `${import.meta.dir}/dist`.replaceAll('\\', '/')
const hasFrontend = Bun.isStandaloneExecutable && existsSync(FRONTEND_DIR)

/** vite 产物涉及的扩展名 -> MIME（不引依赖，清单足够覆盖构建产物） */
const MIME_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  json: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  map: 'application/json; charset=utf-8',
}

function extOf(p: string): string {
  const i = p.lastIndexOf('.')
  return i === -1 ? '' : p.slice(i + 1).toLowerCase()
}

/**
 * 挂载前端 catch-all（GET）。必须在所有业务路由之后注册：
 * 命中文件的路径直出；无扩展名的未知路径回退 index.html（SPA 路由）；
 * 带扩展名但未命中直接 404（便于排查）。
 */
export function registerFrontendRoutes(app: App): void {
  app.get('*', async (c) => {
    // dev/test：无嵌入资源，走统一 404
    if (!hasFrontend) return c.notFound()

    const urlPath = c.req.path
    // 归一化 + 防目录穿越：解析结果必须仍在 FRONTEND_DIR 内
    const resolved = posix.normalize(`${FRONTEND_DIR}${urlPath}`)
    if (!resolved.startsWith(`${FRONTEND_DIR}/`)) return c.notFound()

    let filePath = resolved
    if (!(await Bun.file(filePath).exists())) {
      if (extOf(urlPath)) return c.notFound()
      filePath = `${FRONTEND_DIR}/index.html`
    }

    // vite 默认产物在 /assets/ 且文件名含内容 hash，可永久缓存；index.html 等必须每次校验
    const isHashed = urlPath.startsWith('/assets/')
    return c.body(Bun.file(filePath).stream(), 200, {
      'Content-Type': MIME_TYPES[extOf(filePath)] ?? 'application/octet-stream',
      'Cache-Control': isHashed ? 'public, max-age=31536000, immutable' : 'no-cache',
    })
  })
}
