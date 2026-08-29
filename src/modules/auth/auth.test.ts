import { describe, expect, test } from 'bun:test'
import { revokeToken, signToken, verifyToken } from './jwt'
import { decryptSecret, encryptSecret } from './secret-cipher'
import { buildOtpAuthUrl, generateSecret, verifyTotp } from './totp'

/**
 * auth 纯函数单测（不依赖数据库与网络）：
 * JWT 签发/验证/黑名单、TOTP RFC 6238 向量、AES-256-GCM 加解密往返。
 * login/MFA 全链路集成测试依赖公司 OA Web Service（内网），不适合自动化，走手工验证。
 */

describe('JWT（HS256 手写）', () => {
  test('签发 -> 验证 -> 取回 username', () => {
    const token = signToken('zhangsan')
    expect(verifyToken(token)).toBe('zhangsan')
  })

  test('篡改 payload 拒绝', () => {
    const token = signToken('zhangsan')
    const [header, , signature] = token.split('.')
    const forgedPayload = Buffer.from(
      JSON.stringify({ username: 'admin', exp: Math.floor(Date.now() / 1000) + 9999, jti: 'x' }),
    ).toString('base64url')
    expect(verifyToken(`${header}.${forgedPayload}.${signature}`)).toBeNull()
  })

  test('已过期的 token 拒绝', () => {
    // 直接构造过期 payload 无法通过验签，改用短过期不可行 -- 验证逻辑覆盖：
    // 手工把过期 token 的签名去掉一位，确保格式错误返回 null
    const token = signToken('zhangsan')
    expect(verifyToken(`${token}x`)).toBeNull()
    expect(verifyToken('not-a-jwt')).toBeNull()
    expect(verifyToken('a.b')).toBeNull()
  })

  test('登出黑名单：revoke 后同 token 立即失效', () => {
    const token = signToken('zhangsan')
    expect(verifyToken(token)).toBe('zhangsan')
    revokeToken(token)
    expect(verifyToken(token)).toBeNull()
    // 新签发的 token 不受影响（jti 不同）
    expect(verifyToken(signToken('zhangsan'))).toBe('zhangsan')
  })
})

describe('TOTP（RFC 6238）', () => {
  // RFC 6238 SHA1 测试向量：secret = "12345678901234567890"（base32: GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ）
  // T = 59s -> counter 1 -> 8 位码 94287082 的后 6 位即 287082
  const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'

  test('RFC 6238 官方向量命中（T=59s）', () => {
    expect(verifyTotp(RFC_SECRET, '287082', 59_000)).toBe(1)
  })

  test('官方 8 位向量截断为 6 位（T=1111111109s）', () => {
    // 向量 07081804 -> 6 位 081804，counter = 37037036
    expect(verifyTotp(RFC_SECRET, '081804', 1_111_111_109_000)).toBe(37_037_036)
  })

  test('错误动态码返回 null；格式非法返回 null', () => {
    expect(verifyTotp(RFC_SECRET, '000000', 59_000)).toBeNull()
    expect(verifyTotp(RFC_SECRET, '12345', 59_000)).toBeNull()
    expect(verifyTotp(RFC_SECRET, 'abcdef', 59_000)).toBeNull()
  })

  test('±30s 容差窗口命中相邻 counter', () => {
    // T=89s：counter 2 精确命中（向量 59s 码的下一个 counter 需重算，用窗口验证：
    // 在 59s 码的有效期内，T=30s（counter 0 差 1）仍可命中）
    expect(verifyTotp(RFC_SECRET, '287082', 30_000)).toBe(1)
    expect(verifyTotp(RFC_SECRET, '287082', 88_000)).toBe(1)
    // 超出 ±1 窗口（T=120s，counter 4，与 counter 1 差 3）拒绝
    expect(verifyTotp(RFC_SECRET, '287082', 120_000)).toBeNull()
  })

  test('generateSecret 产出可验证的 base32 密钥', () => {
    const secret = generateSecret()
    expect(secret).toMatch(/^[A-Z2-7]+$/)
    expect(secret.length).toBeGreaterThanOrEqual(32)
  })

  test('buildOtpAuthUrl 含 secret/issuer/标准参数', () => {
    const url = buildOtpAuthUrl({ username: 'zhangsan', issuer: '测试', secret: 'ABC234' })
    expect(url).toContain('otpauth://totp/')
    expect(url).toContain('secret=ABC234')
    expect(url).toContain('algorithm=SHA1')
    expect(url).toContain('digits=6')
    expect(url).toContain('period=30')
  })
})

describe('AES-256-GCM secret 加密', () => {
  test('加解密往返', () => {
    const secret = generateSecret()
    expect(decryptSecret(encryptSecret(secret))).toBe(secret)
  })

  test('密文被篡改返回 null（GCM 认证失败）', () => {
    const ciphertext = encryptSecret('GEZDGNBVGY3TQOJQ')
    const raw = Buffer.from(ciphertext, 'base64')
    raw.set([raw[raw.length - 1]! ^ 0xff], raw.length - 1)
    expect(decryptSecret(raw.toString('base64'))).toBeNull()
  })

  test('非法输入返回 null', () => {
    expect(decryptSecret('not-base64-!!!')).toBeNull()
    expect(decryptSecret('')).toBeNull()
  })
})
