import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * TOTP（RFC 6238）手写实现 -- 自 claude-agent-desktop 原样移植，用于 MFA 二次认证。
 * 算法：HOTP（RFC 4226）= HMAC-SHA1(secret, counter) + 动态截取；TOTP 以 floor(now/30) 为 counter。
 * 兼容 Google Authenticator 等标准 TOTP App（SHA1/6 位/30 秒）。
 *
 * verifyTotpWithCounter 额外返回命中的 counter（供防重放记录）。
 */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
/** 时间步长（秒），RFC 6238 默认 30 */
const STEP = 30
/** 动态码位数 */
const DIGITS = 6
/** 验证时间窗口：前后各 N 个时间片容差（±30s），缓解本机与手机时钟偏差 */
const WINDOW = 1

/** base32 编码（RFC 4648，无填充） */
function base32Encode(buf: Buffer): string {
  let bits = 0
  let value = 0
  let output = ''
  for (const byte of buf) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31]
  }
  return output
}

/** base32 解码（容忍空格/小写/填充） */
function base32Decode(str: string): Buffer {
  const cleaned = str.toUpperCase().replace(/=+$/, '').replace(/\s/g, '')
  let bits = 0
  let value = 0
  const bytes: number[] = []
  for (const c of cleaned) {
    const idx = BASE32_ALPHABET.indexOf(c)
    if (idx === -1) throw new Error(`base32 非法字符：${c}`)
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(bytes)
}

/** HOTP（RFC 4226）：HMAC-SHA1 + 动态截取 -> 6 位十进制码 */
function hotp(secret: Buffer, counter: number): string {
  const buf = Buffer.alloc(8)
  // counter 大端写入 8 字节（BigInt，规避 number 位运算 32 位限制）
  buf.writeBigUInt64BE(BigInt(counter))
  const hmac = createHmac('sha1', secret).update(buf).digest() // 20 字节
  // 动态截取：offset 取 HMAC 末字节低 4 位，读 4 字节并掩码最高位
  const offset = hmac[hmac.length - 1]! & 0x0f
  const binary =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff)
  return (binary % 10 ** DIGITS).toString().padStart(DIGITS, '0')
}

/** 生成随机密钥（20 字节 -> base32，~32 字符） */
export function generateSecret(): string {
  return base32Encode(randomBytes(20))
}

/**
 * 验证动态码；命中时返回命中的时间片 counter（防重放记录用），未命中返回 null。
 * 窗口 [-WINDOW, +WINDOW]，恒定时间比较（对齐 jwt.ts 防时序攻击风格）。
 */
export function verifyTotp(secret: string, token: string, now: number = Date.now()): number | null {
  if (!/^\d{6}$/.test(token)) return null
  const counter = Math.floor(now / 1000 / STEP)
  let decoded: Buffer
  try {
    decoded = base32Decode(secret)
  } catch {
    return null
  }
  for (let i = -WINDOW; i <= WINDOW; i++) {
    const expected = hotp(decoded, counter + i)
    if (
      expected.length === token.length &&
      timingSafeEqual(Buffer.from(expected), Buffer.from(token))
    ) {
      return counter + i
    }
  }
  return null
}

/** 构建 otpauth:// URI（二维码内容，标准 TOTP App 扫码识别） */
export function buildOtpAuthUrl(opts: {
  username: string
  issuer: string
  secret: string
}): string {
  const label = encodeURIComponent(`${opts.issuer}:${opts.username}`)
  const issuer = encodeURIComponent(opts.issuer)
  return (
    `otpauth://totp/${label}` +
    `?secret=${opts.secret}&issuer=${issuer}` +
    `&algorithm=SHA1&digits=${DIGITS}&period=${STEP}`
  )
}
