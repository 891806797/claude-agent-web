import { mkdir } from 'node:fs/promises'
import { platform } from 'node:os'
import { resolve, sep } from 'node:path'
import { AppError } from '@/core/app-error'
import { getLogger } from '@/core/logger'
import { env } from '@/env'
import { agentService } from '@/modules/agent/agent.service'
import { normalizeDir } from '@/modules/agent/paths'
import { generateInternalDoc } from './interface-doc-gen'
import { issueLaunchToken } from './launch-token'

/**
 * deep-link bootstrap —— 冷/热启动共用入口。
 *
 * 协议契约（镜像桌面端 csm-coding-agent，scheme 默认 csm-coding-agent-web）：
 *   <scheme>://download?url=<zip>&name=<工作空间目录名>&user=<审计用户名>[&agent=<persona>]
 * 流程：解析 → 下载 zip → 校验+解压到工作空间 → git-info.json 在场则生成《内部接口文档.md》
 *      → 项目白名单 upsert → 签一次性 launch token → 开浏览器到该工作空间最近会话。
 *
 * 失败不拖垮服务：调用方（index.ts 冷启 / /api/system/launch 热转发）决定兜底。
 */

const logger = getLogger('system-launch')

/** 工作空间根：AGENT_WORKSPACE_ROOT 优先，否则默认 ./data/workspaces */
function workspaceRoot(): string {
  return env.AGENT_WORKSPACE_ROOT || './data/workspaces'
}

/** name 仅允许 [A-Za-z0-9_-]，拒路径分隔/穿越 */
function sanitizeName(name: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    throw new AppError('SYSTEM_DEEPLINK_INVALID', { message: 'name 仅允许字母数字下划线连字符' })
  }
  return name
}

/** 校验工作空间绝对路径必须位于根之下（第二道防线，兜底盘符/穿越） */
function assertWithinRoot(abs: string, root: string): void {
  const r = resolve(root)
  if (abs !== r && !abs.startsWith(`${r}${sep}`)) {
    throw new AppError('SYSTEM_DEEPLINK_INVALID', { message: '工作空间路径越界' })
  }
}

export interface ParsedDeepLink {
  action: string
  zipUrl: string
  name: string
  user: string
  agent?: string
}

/** 解析协议 URL；缺 user / 缺 url / 非 download 动作 → 抛 SYSTEM_DEEPLINK_* */
export function parseDeepLink(rawUrl: string): ParsedDeepLink {
  let u: URL
  try {
    u = new URL(rawUrl)
  } catch {
    throw new AppError('SYSTEM_DEEPLINK_INVALID', { message: '协议链接格式错误' })
  }
  const action = u.host || 'download'
  if (action !== 'download') {
    throw new AppError('SYSTEM_DEEPLINK_INVALID', { message: `不支持的 action: ${action}` })
  }
  const zipUrl = u.searchParams.get('url')
  const name = u.searchParams.get('name')
  const user = u.searchParams.get('user')
  if (!zipUrl || !name || !user) {
    throw new AppError('SYSTEM_DEEPLINK_NO_USER', {
      message: 'deep-link 缺少 url/name/user 参数',
    })
  }
  return {
    action,
    zipUrl,
    name: sanitizeName(name),
    user,
    agent: u.searchParams.get('agent') ?? undefined,
  }
}

/** 下载 zip 到 Buffer；非 zip magic → SYSTEM_DOWNLOAD_FAILED */
async function downloadZip(zipUrl: string): Promise<Buffer> {
  let res: Response
  try {
    res = await fetch(zipUrl)
  } catch (err) {
    throw new AppError('SYSTEM_DOWNLOAD_FAILED', { message: `下载失败: ${String(err)}` })
  }
  if (!res.ok) {
    throw new AppError('SYSTEM_DOWNLOAD_FAILED', { message: `下载失败: HTTP ${res.status}` })
  }
  const buf = Buffer.from(await res.arrayBuffer())
  // PK\x03\x04（zip 本地文件头）；空 zip 用 0x0708 不常见，按 PK\x03/04/05/07 放行
  if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
    throw new AppError('SYSTEM_DOWNLOAD_FAILED', { message: '下载内容不是 zip 压缩包' })
  }
  return buf
}

/** 解压 zip 到工作空间（同名覆盖）。adm-zip 纯 JS，Bun 兼容。 */
async function extractZip(buf: Buffer, target: string): Promise<void> {
  // 动态 import：把 adm-zip 隔离在调用链，避免未安装时启动即崩（构建期才需）
  const AdmZip = (await import('adm-zip')).default
  const zip = new AdmZip(buf)
  zip.extractAllTo(target, true)
}

/** 跨平台开默认浏览器（detached，stdio 忽略） */
export function openBrowser(url: string): void {
  const p = platform()
  const cmd =
    p === 'win32'
      ? ['cmd', '/c', 'start', '', url]
      : p === 'darwin'
        ? ['open', url]
        : ['xdg-open', url]
  try {
    Bun.spawn({ cmd, stdio: ['ignore', 'ignore', 'ignore'] })
    logger.info({ url }, '已打开浏览器')
  } catch (err) {
    logger.warn({ err, url }, '打开浏览器失败')
  }
}

export interface DeepLinkResult {
  workspaceDir: string
  browserUrl: string
}

/**
 * 执行 deep-link bootstrap。冷（index.ts）/ 热（/api/system/launch）共用。
 * @param rawUrl 协议链接（含 user）
 * @param overrideUser 热转发路径已解出 user 时透传，避免重复解析
 */
export async function handleDeepLink(
  rawUrl: string,
  overrideUser?: string,
): Promise<DeepLinkResult> {
  const parsed = parseDeepLink(rawUrl)
  const user = overrideUser ?? parsed.user
  if (!user) throw new AppError('SYSTEM_DEEPLINK_NO_USER')

  const root = workspaceRoot()
  const workspaceAbs = resolve(root, parsed.name)
  assertWithinRoot(workspaceAbs, root)
  await mkdir(workspaceAbs, { recursive: true })

  logger.info({ user, name: parsed.name, zipUrl: parsed.zipUrl }, 'deep-link bootstrap 开始')

  const buf = await downloadZip(parsed.zipUrl)
  await extractZip(buf, workspaceAbs)

  // git-info.json 在场则生成内部接口文档（失败仅告警，不阻断后续开浏览器）
  try {
    await generateInternalDoc(workspaceAbs, env.INTERFACE_PLATFORM_BASE_URL)
  } catch (err) {
    logger.warn({ err, workspaceAbs }, '生成内部接口文档失败（已跳过）')
  }

  // 项目白名单 upsert（openSession 只接受已注册 path）
  await agentService.ensureProject(user, { name: parsed.name, path: normalizeDir(workspaceAbs) })

  // 签一次性 launch token（绑定 user），开浏览器到该工作空间最近会话
  const token = issueLaunchToken(user)
  const wsB64 = Buffer.from(normalizeDir(workspaceAbs), 'utf8').toString('base64url')
  const browserUrl = `http://127.0.0.1:${env.PORT}${env.BASE_URL || ''}/chat?ws=${wsB64}&launch=${token}`
  openBrowser(browserUrl)

  logger.info({ user, workspaceDir: workspaceAbs }, 'deep-link bootstrap 完成')
  return { workspaceDir: normalizeDir(workspaceAbs), browserUrl }
}

/** csmcode 裸启：签 token + 开浏览器到 /chat 根（不指定 ws，侧栏自选） */
export function openRoot(user: string): string {
  const token = issueLaunchToken(user)
  const browserUrl = `http://127.0.0.1:${env.PORT}${env.BASE_URL || ''}/chat?launch=${token}`
  openBrowser(browserUrl)
  return browserUrl
}
