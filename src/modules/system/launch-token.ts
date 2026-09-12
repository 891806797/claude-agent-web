import { randomUUID } from 'node:crypto'
import { getLogger } from '@/core/logger'

/**
 * 本机免登一次性启动令牌 —— deep-link / csmcode 裸启时签发，浏览器换 JWT。
 *
 * 安全模型：
 *   - 令牌绑定的 username 由 deep-link 的 user 参数 / csmcode 的 --user 传入（信任本机，见 launch.service）
 *   - 5 分钟过期、一次性（消费即删）
 *   - 仅 loopback 可消费（/api/auth/local-launch 路由层校验对端 IP）
 * 非密码登录的等价物：本机已被信任，令牌仅是把「谁在用」从命令行/协议参数带进浏览器会话，
 * 让 audit / agent 会话归属 / 日志携带真实用户名。
 */

const TOKEN_TTL_MS = 5 * 60 * 1000

interface LaunchTokenEntry {
  username: string
  expiresAt: number
}

const store = new Map<string, LaunchTokenEntry>()
const logger = getLogger('system-launch-token')

/** 签发一次性令牌（绑定 username） */
export function issueLaunchToken(username: string): string {
  const token = randomUUID()
  store.set(token, { username, expiresAt: Date.now() + TOKEN_TTL_MS })
  return token
}

/** 校验并消费令牌（一次性）；返回绑定的 username 或 null（不存在/过期/已消费） */
export function consumeLaunchToken(token: string): string | null {
  const entry = store.get(token)
  if (!entry) return null
  store.delete(token)
  if (entry.expiresAt < Date.now()) return null
  logger.info({ username: entry.username }, '启动令牌已消费')
  return entry.username
}

/** 启动时清理过期令牌（惰性清理已在 consume 内完成；此处兜底未消费的过期项） */
export function cleanupLaunchTokens(): void {
  const now = Date.now()
  for (const [token, entry] of store) {
    if (entry.expiresAt < now) store.delete(token)
  }
}
