import { resolve } from 'node:path'

/**
 * agent 模块路径工具：目录归一化 + base64url 编解码。
 * Windows 路径含反斜杠/冒号/中文，HTTP header 仅允许 Latin-1，URL 明文也不安全——
 * 线上传输一律 base64url，服务端校验后归一化为 registry 主键。
 */

/**
 * 归一化：绝对化；Windows 再加正斜杠 + 小写（盘符大小写不敏感）。registry 主键/JSONL 定位统一用它。
 * POSIX 文件系统大小写敏感、反斜杠是合法文件名字符，做同样归一会改变路径含义（stat 失败），故不做。
 */
export function normalizeDir(dir: string): string {
  const resolved = resolve(dir)
  return process.platform === 'win32' ? resolved.replaceAll('\\', '/').toLowerCase() : resolved
}

/** 目录路径 → base64url（header/query 传输用） */
export function encodeDir(dir: string): string {
  return Buffer.from(dir, 'utf8').toString('base64url')
}

/** base64url → 目录路径（非法编码抛错，由调用方转 4xx） */
export function decodeDir(b64: string): string {
  return Buffer.from(b64, 'base64url').toString('utf8')
}
