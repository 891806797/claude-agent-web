import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mfaEncKey } from './jwt'

/**
 * AES-256-GCM 应用层加密 -- MFA secret 落库保护（web 版无 electron safeStorage）。
 * 密文格式：base64(iv(12) + tag(16) + ciphertext)，解密按定长切分。
 */

const IV_LENGTH = 12

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv('aes-256-gcm', mfaEncKey, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, encrypted]).toString('base64')
}

/** 解密失败（密钥更换/密文损坏）返回 null，调用方按未绑定处理 */
export function decryptSecret(ciphertext: string): string | null {
  try {
    const raw = Buffer.from(ciphertext, 'base64')
    const iv = raw.subarray(0, IV_LENGTH)
    const tag = raw.subarray(IV_LENGTH, IV_LENGTH + 16)
    const encrypted = raw.subarray(IV_LENGTH + 16)
    const decipher = createDecipheriv('aes-256-gcm', mfaEncKey, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}
