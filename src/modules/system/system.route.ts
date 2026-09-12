import { createRoute, z } from '@hono/zod-openapi'
import type { Context } from 'hono'
import { AppError } from '@/core/app-error'
import { ApiResponseSchema, ErrorResponseSchema, jsonResponse, ok } from '@/core/response'
import type { App, AppEnv } from '@/core/types'
import { handleDeepLink } from './launch.service'
import { DownloadUpdateResultDto, LaunchInput, VersionResultDto } from './system.schema'
import { applyUpdate, checkUpdate, downloadUpdate, isUpdating } from './system.service'

/**
 * system 路由层 —— handler 三步走：c.req.valid() -> service -> ok()，无 try-catch。
 * deep-link 热转发入口 /launch 与本机免登 /local-launch 均 loopback-only。
 */

/** loopback 判定：直连无 x-forwarded-for 即视为本机（与 auth.route clientIp 同口径） */
function assertLoopback(c: Context<AppEnv>): void {
  if (c.req.header('x-forwarded-for')) {
    throw new AppError('SYSTEM_LAUNCH_TOKEN_INVALID', { message: '仅限本机调用' })
  }
}

const versionRoute = createRoute({
  method: 'get',
  path: '/version',
  tags: ['system'],
  summary: '版本检测（current + latest + updateAvailable）',
  responses: {
    200: jsonResponse(ApiResponseSchema(VersionResultDto), '成功'),
  },
})

const updateDownloadRoute = createRoute({
  method: 'post',
  path: '/update/download',
  tags: ['system'],
  summary: '下载新版本到暂存区（校验 sha256）',
  responses: {
    200: jsonResponse(ApiResponseSchema(DownloadUpdateResultDto), '已下载'),
    503: jsonResponse(ErrorResponseSchema, 'dev 模式不可更新 / 清单未配置'),
    509: jsonResponse(ErrorResponseSchema, '未配置更新清单'),
  },
})

const updateApplyRoute = createRoute({
  method: 'post',
  path: '/update/apply',
  tags: ['system'],
  summary: '应用更新（spawn 替换脚本 → 停服务 → 退出，由脚本替换重启）',
  responses: {
    204: { description: '已 spawn 替换脚本，即将退出' },
    503: jsonResponse(ErrorResponseSchema, '尚未下载 / 正在更新'),
  },
})

const launchRoute = createRoute({
  method: 'post',
  path: '/launch',
  tags: ['system'],
  summary: 'deep-link 热转发入口（loopback-only；冷启走 argv 不走此）',
  request: {
    body: { required: true, content: { 'application/json': { schema: LaunchInput } } },
  },
  responses: {
    200: jsonResponse(
      ApiResponseSchema(z.object({ workspaceDir: z.string(), browserUrl: z.string() })),
      'bootstrap 完成',
    ),
    422: jsonResponse(ErrorResponseSchema, '协议链接非法'),
    503: jsonResponse(ErrorResponseSchema, '更新中'),
  },
})

export function registerSystemRoutes(app: App): void {
  app.openapi(versionRoute, async (c) => {
    return ok(c, await checkUpdate())
  })

  app.openapi(updateDownloadRoute, async (c) => {
    const r = await downloadUpdate()
    return ok(c, { ok: true as const, path: r.path, version: r.version })
  })

  app.openapi(updateApplyRoute, async (c) => {
    if (isUpdating()) throw new AppError('SYSTEM_UPDATING')
    assertLoopback(c)
    await applyUpdate()
    return c.body(null, 204)
  })

  app.openapi(launchRoute, async (c) => {
    assertLoopback(c)
    if (isUpdating()) throw new AppError('SYSTEM_UPDATING')
    const { url } = c.req.valid('json')
    const r = await handleDeepLink(url)
    return ok(c, { workspaceDir: r.workspaceDir, browserUrl: r.browserUrl })
  })
}
