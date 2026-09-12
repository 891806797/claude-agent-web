import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { arch, platform, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { AppError } from '@/core/app-error'
import { getLogger } from '@/core/logger'
import { env } from '@/env'
import type { LatestManifest, PlatformKey, VersionResult } from './system.schema'
import { posixUpdaterScript, winUpdaterScript } from './updater-scripts'

// 构建期 --define APP_VERSION='"x"' 注入；dev 未定义时 typeof 守卫安全回退
declare const APP_VERSION: string | undefined

/** Bun.serve 实例（index.ts 启动时 setServer 注入），applyUpdate 用来停止接收连接 */
let server: { stop: (force?: boolean) => void } | null = null
export function setServer(s: { stop: (force?: boolean) => void }): void {
  server = s
}

const logger = getLogger('system-updater')

/** 当前版本：构建期注入，dev 回退 0.0.0-dev */
export function getCurrentVersion(): string {
  return (typeof APP_VERSION !== 'undefined' ? APP_VERSION : undefined) ?? '0.0.0-dev'
}

/** 当前平台归一化 key（与 build-exe.ts 命名一致） */
function currentPlatformKey(): PlatformKey {
  const p = platform() === 'win32' ? 'windows' : platform() === 'darwin' ? 'darwin' : 'linux'
  return `${p}-${arch()}` as PlatformKey
}

/** 版本号比对：dotted numeric；高位大者胜。非数字段按字符串比。导出供单测。 */
export function compareVersion(a: string, b: string): number {
  const pa = a.split('.')
  const pb = b.split('.')
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const na = Number(pa[i])
    const nb = Number(pb[i])
    if (!Number.isNaN(na) && !Number.isNaN(nb)) {
      if (na !== nb) return na - nb
    } else {
      const sa = pa[i] ?? ''
      const sb = pb[i] ?? ''
      if (sa !== sb) return sa < sb ? -1 : 1
    }
  }
  return 0
}

let manifestCache: { at: number; data: LatestManifest } | null = null
const MANIFEST_TTL_MS = 60_000

async function fetchManifest(force = false): Promise<LatestManifest> {
  if (!env.UPDATE_MANIFEST_URL) {
    throw new AppError('SYSTEM_UPDATE_UNCONFIGURED')
  }
  if (manifestCache && !force && Date.now() - manifestCache.at < MANIFEST_TTL_MS) {
    return manifestCache.data
  }
  const res = await fetch(env.UPDATE_MANIFEST_URL)
  if (!res.ok)
    throw new AppError('SYSTEM_UPDATE_UNCONFIGURED', { message: `清单拉取失败 HTTP ${res.status}` })
  const data = (await res.json()) as LatestManifest
  manifestCache = { at: Date.now(), data }
  return data
}

/** 版本检测：current + latest + updateAvailable（latest 无配置/拉取失败时 updateAvailable=false） */
export async function checkUpdate(): Promise<VersionResult> {
  const current = getCurrentVersion()
  if (!env.UPDATE_MANIFEST_URL) {
    return { current, latest: null, updateAvailable: false }
  }
  try {
    const manifest = await fetchManifest()
    const latest = manifest.version
    return {
      current,
      latest,
      updateAvailable: compareVersion(latest, current) > 0,
      releaseDate: manifest.releaseDate ?? null,
    }
  } catch (err) {
    if (AppError.is(err)) throw err
    logger.warn({ err }, '版本检测拉取清单失败')
    return { current, latest: null, updateAvailable: false }
  }
}

// ===== 下载 + 应用 =====

let downloaded: { path: string; version: string } | null = null
let updating = false

function isStandalone(): boolean {
  return Boolean(Bun.isStandaloneExecutable)
}

/** 下载新版本 exe 到暂存区并校验 sha256；幂等（已下载同版本直接复用） */
export async function downloadUpdate(): Promise<{ path: string; version: string }> {
  if (!isStandalone()) {
    // dev 模式下 process.execPath 指向 bun 运行时，替换无意义且危险
    throw new AppError('SYSTEM_UPDATE_UNCONFIGURED', { message: 'dev 模式不可自更新' })
  }
  const manifest = await fetchManifest()
  const key = currentPlatformKey()
  const asset = manifest.platforms?.[key]
  if (!asset) {
    throw new AppError('SYSTEM_UPDATE_UNCONFIGURED', { message: `清单无当前平台 ${key} 的产物` })
  }
  if (downloaded && downloaded.version === manifest.version) {
    return downloaded
  }
  const res = await fetch(asset.url)
  if (!res.ok)
    throw new AppError('SYSTEM_DOWNLOAD_FAILED', { message: `下载失败 HTTP ${res.status}` })
  const buf = Buffer.from(await res.arrayBuffer())
  const sha = createHash('sha256').update(buf).digest('hex')
  if (sha !== asset.sha256) {
    throw new AppError('SYSTEM_DOWNLOAD_FAILED', { message: 'sha256 校验失败' })
  }
  const exeDir = dirname(process.execPath)
  const stageDir = join(exeDir, '.update')
  await mkdir(stageDir, { recursive: true })
  const ext = platform() === 'win32' ? '.exe' : ''
  const newPath = join(stageDir, `app.new${ext}`)
  await writeFile(newPath, buf)
  downloaded = { path: newPath, version: manifest.version }
  logger.info({ version: manifest.version, path: newPath, size: buf.length }, '新版本已下载')
  return downloaded
}

/**
 * 应用更新：写替换脚本 → detached spawn → 停服务 → exit(0)。
 * 独立解释器（powershell/sh）在原进程退出后 Move-Item/mv 覆盖并重启 exe。
 */
export async function applyUpdate(): Promise<void> {
  if (!isStandalone())
    throw new AppError('SYSTEM_UPDATE_UNCONFIGURED', { message: 'dev 模式不可自更新' })
  if (!downloaded) throw new AppError('SYSTEM_NOT_READY', { message: '尚未下载新版本' })
  if (updating) throw new AppError('SYSTEM_UPDATING')
  updating = true

  const { path: newPath } = downloaded
  const target = process.execPath
  const pid = String(process.pid)
  const isWin = platform() === 'win32'
  const scriptPath = join(tmpdir(), `csm-update-${pid}.${isWin ? 'ps1' : 'sh'}`)
  await writeFile(scriptPath, isWin ? winUpdaterScript() : posixUpdaterScript())

  const cmd = isWin
    ? [
        'powershell',
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
        pid,
        newPath,
        target,
      ]
    : ['sh', scriptPath, pid, newPath, target]
  try {
    Bun.spawn({ cmd, stdio: ['ignore', 'ignore', 'ignore'], detached: true })
    logger.info({ pid, target, scriptPath }, '更新脚本已 spawn，准备退出')
  } catch (err) {
    updating = false
    throw new AppError('SYSTEM_UPDATE_UNCONFIGURED', {
      message: `启动替换脚本失败: ${String(err)}`,
    })
  }
  // 给脚本一点时间握住 fd，再停服务退出
  setTimeout(() => {
    server?.stop(true)
    process.exit(0)
  }, 300)
}

/** 是否正在更新中（deep-link/launch 转发进来时回 503） */
export function isUpdating(): boolean {
  return updating
}
