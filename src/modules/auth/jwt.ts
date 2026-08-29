import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { env } from '@/env'

/**
 * JWT（HS256）签发与验证 + 登出黑名单 -- 自 claude-agent-desktop 移植并增强。
 *
 * 增强：payload 加 jti（每次签发唯一），登出时 jti 入内存黑名单（TTL 至 exp），
 * 已建立的 EventSource/旧 token 在过期前重连即 401。手写 HS256，不引入 jsonwebtoken。
 */

export interface JwtPayload {
  username: string
  /** 角色（role 字段加入前的旧 token 无此字段，读取时按 'user' 处理） */
  role?: 'admin' | 'user'
  /** 过期时间戳（秒） */
  exp: number
  /** 签发唯一 ID（登出黑名单键） */
  jti: string
}

/** 7 天过期（秒） */
const EXPIRES_SECONDS = 7 * 24 * 60 * 60

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url')
}

function hmacSign(data: string): string {
  return createHmac('sha256', env.AUTH_JWT_SECRET).update(data).digest('base64url')
}

/** 签发 JWT（username + role + jti + 7 天过期） */
export function signToken(username: string, role: 'admin' | 'user'): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const now = Math.floor(Date.now() / 1000)
  const payload = base64url(
    JSON.stringify({ username, role, exp: now + EXPIRES_SECONDS, jti: randomUUID() }),
  )
  const data = `${header}.${payload}`
  return `${data}.${hmacSign(data)}`
}

/** 登出黑名单：jti -> 过期秒级时间戳；过期项惰性清理 */
const revoked = new Map<string, number>()

/** 登出拉黑：该 token 在自然过期前不可再使用 */
export function revokeToken(token: string): void {
  const payload = decodePayload(token)
  if (payload?.jti) {
    revoked.set(payload.jti, payload.exp)
  }
}

function isRevoked(payload: JwtPayload): boolean {
  const exp = revoked.get(payload.jti)
  if (exp === undefined) return false
  if (exp < Math.floor(Date.now() / 1000)) {
    revoked.delete(payload.jti) // 惰性清理过期项
    return false
  }
  return true
}

/** 仅解码（不验签），黑名单登记用 */
function decodePayload(token: string): JwtPayload | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    return JSON.parse(Buffer.from(parts[1]!, 'base64url').toString()) as JwtPayload
  } catch {
    return null
  }
}

/** 从已验签 token（requireAuth 通过后的请求内使用）取角色；旧 token 无 role 视为 user */
export function roleFromToken(token: string): 'admin' | 'user' {
  const payload = decodePayload(token)
  return payload?.role ?? 'user'
}

/** 验证签名 + 过期 + 黑名单；通过返回 username */
export function verifyToken(token: string): string | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [header, payload, signature] = parts
  const data = `${header}.${payload}`
  const expected = hmacSign(data)
  const sigBuf = Buffer.from(signature!)
  const expBuf = Buffer.from(expected)
  // 长度不等直接拒绝；等长才用 timingSafeEqual 防时序攻击
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    return null
  }
  try {
    const decoded = JSON.parse(Buffer.from(payload!, 'base64url').toString()) as JwtPayload
    if (typeof decoded.exp !== 'number' || typeof decoded.username !== 'string') return null
    if (decoded.exp < Math.floor(Date.now() / 1000)) return null
    if (decoded.jti && isRevoked(decoded)) return null
    return decoded.username
  } catch {
    return null
  }
}

/**
 * MFA secret 落库加密密钥：显式 AUTH_MFA_ENC_KEY 优先，否则从 AUTH_JWT_SECRET 派生
 * （sha256 摘要截 32 字节），保证未配置时仍有独立于签名的密钥材料。
 */
export const mfaEncKey: Buffer = env.AUTH_MFA_ENC_KEY
  ? createHash('sha256').update(env.AUTH_MFA_ENC_KEY).digest()
  : createHash('sha256').update(`mfa-enc:${env.AUTH_JWT_SECRET}`).digest()
