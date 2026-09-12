import { userInfo } from 'node:os'
import { cleanupOldLogFiles, getLogger } from '@/core/logger'
import { client } from '@/db'
import { runMigrations } from '@/db/migrate'
import { env } from '@/env'
import {
  acquireOrForward,
  dispatch as dispatchFrame,
  type Frame,
  setFrameHandler,
} from '@/modules/system/instance-lock'
import { setServer } from '@/modules/system/system.service'
import { app } from './app'

const logger = getLogger('server')

/** 从 argv 解析本次启动意图：deep-link / open / null（后台自启） */
function resolveFrame(): Frame | null {
  const argv = process.argv.slice(2)
  const schemePrefix = `${env.DEEP_LINK_SCHEME}:`
  const dlUrl = argv.find((a) => a.startsWith(schemePrefix))
  if (dlUrl) return { kind: 'deep-link', url: dlUrl }
  if (argv.includes('--open')) {
    const idx = argv.indexOf('--user')
    const userArg = idx >= 0 ? argv[idx + 1] : undefined
    return { kind: 'open', user: userArg || env.CSMCODE_USER || userInfo().username }
  }
  return null
}

async function main() {
  // 单实例 + 冷热转发：必须在起服务前判定（转发则直接退出，不绑 PORT、不开 DB）
  const coldFrame = resolveFrame()
  if ((await acquireOrForward(coldFrame)) === 'forwarded') {
    process.exit(0)
  }

  // 启动即迁移：显式 MIGRATE_ON_START 优先；未设置时编译版默认开，dev 默认关
  if (env.MIGRATE_ON_START ?? Bun.isStandaloneExecutable) {
    await runMigrations()
  }

  // 清理过期日志文件（按 LOG_RETENTION_DAYS）
  cleanupOldLogFiles()

  // 生产环境使用默认 JWT 密钥时强提醒（不阻断启动）
  if (env.NODE_ENV === 'production' && env.AUTH_JWT_SECRET.includes('change-me')) {
    logger.warn('AUTH_JWT_SECRET 为默认值，生产环境必须更换！')
  }

  // 启动清扫：终止上次崩溃遗留的 claude.exe 孤儿进程（见 agent/session-registry）
  const { startupOrphanSweep } = await import('@/modules/agent/session-registry')
  await startupOrphanSweep()

  const server = Bun.serve({
    port: env.PORT,
    fetch: app.fetch,
    idleTimeout: 30,
  })
  setServer(server)

  // 服务就绪：注册实时帧处理器（同时冲转发服务启动期间排队的 warm 帧）
  setFrameHandler(dispatchFrame)
  // 处理本次冷启动意图（deep-link bootstrap / csmcode open）；后台自启 coldFrame=null 不动
  if (coldFrame) dispatchFrame(coldFrame)

  logger.info({ port: server.port, env: env.NODE_ENV, logBody: env.LOG_BODY }, '服务已启动')

  // 优雅停机：关闭全部 agent 会话 -> 停止接收新连接 -> 关闭数据库连接池
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      logger.info({ signal }, '正在关闭服务')
      void (async () => {
        try {
          const { closeAllAgentSessions } = await import('@/modules/agent/session-registry')
          await closeAllAgentSessions('shutdown')
        } finally {
          server.stop(true)
          await client.end({ timeout: 5 }).then(() => process.exit(0))
        }
      })()
    })
  }
}

void main()
