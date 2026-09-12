import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import ObsClient from 'esdk-obs-nodejs'

/**
 * 发布到华为云 OBS —— 上传 bin/ 下各平台 exe + 生成 latest.json 清单。
 *
 * 清单契约（system.service.checkUpdate 读）：
 *   { version, releaseDate, platforms: { "windows-x64": { url, sha256, size }, ... } }
 * 产物 ACL: public-read；URL = https://{OBS_BUCKET}.{OBS_ENDPOINT}/{OBS_PREFIX}/{filename}
 *
 * 用法：
 *   bun run scripts/publish-obs.ts
 *   环境变量：OBS_ACCESS_KEY_ID / OBS_SECRET_ACCESS_KEY / OBS_ENDPOINT /
 *            OBS_BUCKET / OBS_PREFIX（默认 imsp/csm/ai-agent-web） /
 *            OBS_URL_BASE（可选，覆盖清单里的 URL 前缀）
 */

// biome-ignore lint/suspicious/noConsole: 发布脚本输出面向终端用户
const say = console.log

const ACCESS_KEY = Bun.env.OBS_ACCESS_KEY_ID
const SECRET_KEY = Bun.env.OBS_SECRET_ACCESS_KEY
const ENDPOINT = Bun.env.OBS_ENDPOINT
const BUCKET = Bun.env.OBS_BUCKET
const PREFIX = (Bun.env.OBS_PREFIX || 'imsp/csm/ai-agent-web').replace(/^\/+|\/+$/g, '')
const URL_BASE = Bun.env.OBS_URL_BASE || (BUCKET && ENDPOINT ? `https://${BUCKET}.${ENDPOINT}` : '')

const REQUIRED = { ACCESS_KEY, SECRET_KEY, ENDPOINT, BUCKET }
for (const [name, val] of Object.entries(REQUIRED)) {
  if (!val) {
    say(
      `✗ 缺少环境变量 ${name}（OBS 发布需 OBS_ACCESS_KEY_ID/OBS_SECRET_ACCESS_KEY/OBS_ENDPOINT/OBS_BUCKET）`,
    )
    process.exit(1)
  }
}

const PLATFORM_KEYS = [
  'windows-x64',
  'linux-x64',
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
] as const

const { version } = await Bun.file('package.json').json()
const obs = new ObsClient({
  access_key_id: ACCESS_KEY!,
  secret_access_key: SECRET_KEY!,
  server: `https://${ENDPOINT}`,
})

interface Asset {
  url: string
  sha256: string
  size: number
}
const platforms: Record<string, Asset> = {}

async function findInBin(names: string[]): Promise<{ path: string; name: string } | null> {
  const entries = await readdir('bin').catch(() => [] as string[])
  for (const name of names) {
    if (entries.includes(name)) return { path: join('bin', name), name }
  }
  return null
}

async function upload(key: string, body: string | Buffer, contentType: string): Promise<void> {
  const res = await obs.putObject({
    Bucket: BUCKET!,
    Key: key,
    Body: body,
    ACL: 'public-read',
    ContentType: contentType,
  })
  const status = res.CommonMsg?.Status ?? 0
  if (status < 200 || status >= 300) {
    throw new Error(`OBS putObject ${key} 失败: ${status} ${res.CommonMsg?.Message ?? ''}`)
  }
}

say(`==> 发布 v${version} 到 OBS: ${BUCKET}/${PREFIX}/`)
for (const key of PLATFORM_KEYS) {
  const base = `app-${key}-${version}`
  const found = await findInBin([base, `${base}.exe`])
  if (!found) {
    say(`  跳过 ${key}（bin/ 无 ${base}[.exe]）`)
    continue
  }
  const buf = await readFile(found.path)
  const sha = createHash('sha256').update(buf).digest('hex')
  const size = (await stat(found.path)).size
  const objKey = `${PREFIX}/${found.name}`
  await upload(objKey, buf, 'application/octet-stream')
  platforms[key] = { url: `${URL_BASE}/${objKey}`, sha256: sha, size }
  say(`  ✓ ${found.name} (${size} bytes, sha256=${sha.slice(0, 12)}…)`)
}

const manifest = {
  version,
  releaseDate: new Date().toISOString(),
  platforms,
}
const manifestKey = `${PREFIX}/latest.json`
await upload(manifestKey, JSON.stringify(manifest, null, 2), 'application/json')
say(`✓ latest.json -> ${URL_BASE}/${manifestKey}`)
say('发布完成。exe 命名 app-{platformArch}-{version}[.exe]，启动自更新读 latest.json。')
