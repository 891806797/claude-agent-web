import QRCode from 'qrcode'
import { AppError } from '@/core/app-error'
import { log } from '@/core/logger'
import { db } from '@/db'
import { env } from '@/env'
import { authRepository } from './auth.repository'
import { decryptSecret, encryptSecret } from './secret-cipher'
import { soapVerifyLogin } from './soap'
import { buildOtpAuthUrl, generateSecret, verifyTotp } from './totp'

/**
 * auth 业务层 -- 不 import hono 任何内容（可独立单测）。
 * 流程（对齐 claude-agent-desktop，强制 MFA）：
 *   login（SOAP 验密 + 限流）-> 未绑定走 setup（先验密）+ confirm
 *                        -> 已绑定走 verify；confirm/verify 通过才签发 JWT。
 * 安全不变量：MFA secret 全程不出后端（落库 AES-256-GCM 密文）；
 * TOTP 防重放（记录 last counter，同 counter 码 60s 内不可复用）。
 */

/** pending secret 存活时间（setup 后未 confirm 的临时密钥，内存态） */
const PENDING_TTL_MS = 5 * 60 * 1000

interface PendingSecret {
  secret: string
  expiresAt: number
}

/** setup 生成、尚未 confirm 持久化的 secret（username -> PendingSecret） */
const pendingStore = new Map<string, PendingSecret>()

function takePending(username: string): string | null {
  const p = pendingStore.get(username)
  if (!p) return null
  if (p.expiresAt < Date.now()) {
    pendingStore.delete(username)
    return null
  }
  return p.secret
}

/** 限流窗口起点 */
function windowStart(): Date {
  return new Date(Date.now() - env.AUTH_LOGIN_WINDOW_MINUTES * 60 * 1000)
}

/** 密码验证（SOAP）前置：限流检查（用户名+IP 窗口内失败次数） */
async function assertNotLocked(username: string, ip: string): Promise<void> {
  const failures = await authRepository.countFailuresSince(db, username, ip, windowStart())
  if (failures >= env.AUTH_LOGIN_MAX_FAILURES) {
    throw new AppError('AUTH_LOCKED', {
      message: `连续失败 ${failures} 次，请 ${env.AUTH_LOGIN_WINDOW_MINUTES} 分钟后再试`,
    })
  }
}

/** SOAP 验密（记录 attempt 流水；网络级故障与密码错误区分开） */
async function verifyPassword(username: string, password: string, ip: string): Promise<void> {
  const result = await soapVerifyLogin(username, password)
  await authRepository.recordAttempt(db, { username, ip, success: result.success })
  if (!result.success) {
    // 服务端明确拒绝 -> 凭证错误；调用异常（网络/格式）-> 网关错误
    if (result.message.startsWith('登录服务')) {
      log().warn({ username }, '登录服务不可用')
      throw new AppError('AUTH_LOGIN_SERVICE_ERROR')
    }
    throw new AppError('AUTH_FAILED', { message: result.message })
  }
}

export const authService = {
  /** 登录第一步：SOAP 验密（含限流）。通过不签发 token，恒需 MFA 二次验证 */
  async login(
    input: { username: string; password: string },
    ip: string,
  ): Promise<{ needMfa: true }> {
    await assertNotLocked(input.username, ip)
    await verifyPassword(input.username, input.password, ip)
    await authRepository.ensureUser(db, input.username)
    return { needMfa: true }
  },

  /** 查询是否已绑定 MFA（登录页决定走绑定还是验证） */
  async mfaStatus(username: string): Promise<{ bound: boolean }> {
    const user = await authRepository.findByUsername(db, username)
    return { bound: Boolean(user?.mfaSecretEnc) }
  },

  /** 生成绑定二维码：先验密（防任意人为他人账号生成 pending），secret 仅存内存 */
  async mfaSetup(
    input: { username: string; password: string },
    ip: string,
  ): Promise<{ otpauthUrl: string; qrDataUrl: string }> {
    await assertNotLocked(input.username, ip)
    await verifyPassword(input.username, input.password, ip)
    if (await authService.mfaStatus(input.username).then((s) => s.bound)) {
      throw new AppError('MFA_ALREADY_BOUND')
    }
    const secret = generateSecret()
    const otpauthUrl = buildOtpAuthUrl({
      username: input.username,
      issuer: env.AUTH_MFA_ISSUER,
      secret,
    })
    const qrDataUrl = await QRCode.toDataURL(otpauthUrl, { width: 200, margin: 1 })
    pendingStore.set(input.username, { secret, expiresAt: Date.now() + PENDING_TTL_MS })
    return { otpauthUrl, qrDataUrl }
  },

  /** 首次绑定确认：验 pending secret 动态码 -> 持久化（AES 密文）+ 签发 JWT */
  async mfaConfirm(input: { username: string; token: string }): Promise<string> {
    const secret = takePending(input.username)
    if (!secret) {
      throw new AppError('MFA_PENDING_EXPIRED')
    }
    const counter = verifyTotp(secret, input.token)
    if (counter === null) {
      throw new AppError('MFA_TOKEN_INVALID')
    }
    await authRepository.updateMfaBinding(db, input.username, {
      mfaSecretEnc: encryptSecret(secret),
      mfaBoundAt: new Date(),
    })
    await authRepository.updateTotpCounter(db, input.username, counter)
    await authRepository.touchLastLogin(db, input.username)
    pendingStore.delete(input.username)
    log().info({ username: input.username }, 'MFA 绑定成功')
    return input.username
  },

  /** 已绑定登录验证：验持久化 secret 动态码（含防重放）-> 签发 JWT */
  async mfaVerify(input: { username: string; token: string }): Promise<string> {
    const user = await authRepository.findByUsername(db, input.username)
    if (!user?.mfaSecretEnc) {
      throw new AppError('MFA_NOT_BOUND')
    }
    const secret = decryptSecret(user.mfaSecretEnc)
    if (!secret) {
      // 解密失败（密钥更换/密文损坏）视同未绑定，需重新绑定
      throw new AppError('MFA_NOT_BOUND', { message: 'MFA 数据异常，请联系管理员重置' })
    }
    const counter = verifyTotp(secret, input.token)
    if (counter === null) {
      throw new AppError('MFA_TOKEN_INVALID')
    }
    // 防重放：命中的 counter 不允许 <= 上次已用 counter（±1 容差窗口内的旧码不可复用）
    if (user.totpLastCounter !== null && counter <= user.totpLastCounter) {
      throw new AppError('MFA_TOKEN_INVALID', { message: '动态码已使用，请等待下一个' })
    }
    await authRepository.updateTotpCounter(db, input.username, counter)
    await authRepository.touchLastLogin(db, input.username)
    return input.username
  },

  /** 解绑：重验密码（必须）；提供了动态码则一并校验（管理页），未提供走「手机丢失重置」路径 */
  async mfaUnbind(
    input: { username: string; password: string; token?: string },
    ip: string,
  ): Promise<void> {
    await assertNotLocked(input.username, ip)
    await verifyPassword(input.username, input.password, ip)
    const user = await authRepository.findByUsername(db, input.username)
    if (user?.mfaSecretEnc && input.token !== undefined) {
      const secret = decryptSecret(user.mfaSecretEnc)
      if (secret === null || verifyTotp(secret, input.token) === null) {
        throw new AppError('MFA_TOKEN_INVALID')
      }
    }
    await authRepository.unbindMfa(db, input.username)
    pendingStore.delete(input.username)
    log().info({ username: input.username }, 'MFA 已解绑')
  },

  /** 定期清理：登录流水只保留最近 N 天（配合外层定时调用） */
  async cleanupLoginAttempts(retainDays = 7): Promise<void> {
    await authRepository.cleanupAttempts(
      db,
      new Date(Date.now() - retainDays * 24 * 60 * 60 * 1000),
    )
  },

  /** 用户列表（管理页；按最近登录排序） */
  async listUsers(): Promise<
    Array<{ username: string; mfaBoundAt: Date | null; lastLoginAt: Date | null; createdAt: Date }>
  > {
    return authRepository.listUsers(db)
  },

  /** 管理员重置用户 MFA（清绑定，用户需重新绑定 + 登录验证）；用户不存在 404 */
  async resetUserMfa(username: string): Promise<void> {
    const user = await authRepository.findByUsername(db, username)
    if (!user) {
      throw new AppError('NOT_FOUND', { message: '用户不存在' })
    }
    await authRepository.unbindMfa(db, username)
    pendingStore.delete(username)
    log().info({ target: username }, 'MFA 已被管理员重置')
  },
}
