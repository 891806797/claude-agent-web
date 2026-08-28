import { existsSync, readdirSync, rmSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { $ } from 'bun'

/**
 * 可执行文件打包编排：bun run build [-- --target=bun-linux-x64]
 *
 * 流程：构建前端（ui）-> 编译单文件可执行（--asset 内嵌 ui/dist 与 migrations）
 * 产物（bin/）：
 *   app-{platform}-{arch}-{version}[.exe]  唯一产物：单文件可执行
 *   （内嵌 bun 运行时 + 前端页面 + 数据库迁移；编译版默认启动即迁移）
 *
 * 运行方式：
 *   cd bin
 *   DATABASE_URL=... PORT=... ./app-...
 *   （也可在 bin 下放 .env，bun 编译版仍会自动加载 cwd 的 .env）
 */

// biome-ignore lint/suspicious/noConsole: 构建脚本输出面向终端用户，非应用日志
const say = console.log

const OUT_DIR = 'bin'
const UI_DIR = 'ui'
const DIST_DIR = `${UI_DIR}/dist`
const MIGRATIONS_SRC = 'src/db/migrations'

/** process.platform -> 打包命名用平台名（与 bun target 命名一致） */
function mapPlatform(p: string): string {
  if (p === 'win32') return 'windows'
  if (p === 'darwin') return 'darwin'
  return 'linux'
}

/** 删除产物目录下 sourcemap 残留（对编译产物无用且泄露源码） */
function removeSourcemaps(dir: string): void {
  for (const name of readdirSync(dir)) {
    if (name.endsWith('.map')) unlinkSync(join(dir, name))
  }
}

async function main() {
  const { version } = await Bun.file('package.json').json()

  // 目标平台：--target=bun-{platform}-{arch}[-musl] 覆盖（交叉编译），默认编当前平台
  const argTarget = process.argv.find((a) => a.startsWith('--target='))
  const target =
    argTarget?.slice('--target='.length) ?? `bun-${mapPlatform(process.platform)}-${process.arch}`
  const platformArch = target.replace(/^bun-/, '')
  if (!platformArch) {
    throw new Error(`无效 target：${target}（格式如 bun-linux-x64）`)
  }

  if (!existsSync(MIGRATIONS_SRC)) {
    throw new Error(`迁移目录不存在：${MIGRATIONS_SRC}（先运行 bun run db:generate）`)
  }

  rmSync(OUT_DIR, { recursive: true, force: true })

  say('==> 构建前端（ui -> ui/dist）...')
  await $`cd ${UI_DIR} && bun run build`
  if (!existsSync(`${DIST_DIR}/index.html`)) {
    throw new Error('前端构建产物缺失：ui/dist/index.html')
  }

  say(`==> 编译可执行文件（target=${target}，内嵌前端 + 迁移）...`)
  // 注意1：compile 模式走 CLI（Bun.build API 的 compile 在编译产物落盘上不如 CLI 可靠）
  // 注意2：禁用 --bytecode——bun 1.4.0 下 bytecode 与 --asset 嵌入不兼容（嵌入失效），
  //        常驻 web 服务对冷启动不敏感；升级 bun 验证修复后可恢复
  // 注意3：--asset 按目录 basename 挂载到 bunfs 根（ui/dist -> dist/，migrations -> migrations/）
  await $`bun build --compile --minify --sourcemap=none --asset ./${DIST_DIR} --asset ./${MIGRATIONS_SRC} --target=${target} --outfile ${OUT_DIR}/app-${platformArch}-${version} src/index.ts`

  removeSourcemaps(OUT_DIR)

  // Windows 编译版由 bun 自动补 .exe 后缀，这里探测实际产物名
  const exe = existsSync(`${OUT_DIR}/app-${platformArch}-${version}.exe`)
    ? `app-${platformArch}-${version}.exe`
    : `app-${platformArch}-${version}`

  say(`
打包完成。产物（bin/）：
  ${exe}  单文件可执行（内嵌 bun 运行时 + 前端页面 + 数据库迁移，约 100MB 属正常）
  编译版默认启动即迁移；如需关闭设 MIGRATE_ON_START=false

运行示例（Windows PowerShell）：
  cd bin
  $env:DATABASE_URL = 'postgres://user:pass@host:5432/dbname'
  .\\${exe}

运行示例（Linux/macOS）：
  cd bin
  DATABASE_URL=... ./${exe}
`)
}

main().catch((err) => {
  say(`打包失败: ${err instanceof Error ? err.message : err}`)
  process.exit(1)
})
