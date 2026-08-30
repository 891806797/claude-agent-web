import { existsSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { $ } from 'bun'

/**
 * 可执行文件打包编排：bun run build [-- --target=bun-linux-x64]
 *
 * 流程：构建前端（ui）-> 编译单文件可执行（--asset 内嵌 ui/dist 与 migrations）
 * 产物（bin/）：
 *   app-{platform}-{arch}-{version}[.exe]  单文件可执行
 *   （内嵌 bun 运行时 + 前端页面 + 数据库迁移；编译版默认启动即迁移）
 *   多平台产物共存：每次构建只替换本目标同名产物，不清空 bin/
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

/** 可内嵌 CLI 的目标 -> SDK 平台包名（与 src/modules/agent/cli-path.ts 的平台分支一一对应）。
 *  其余变体（linux-musl / darwin-x64 / arm64 系）无内嵌分支：产物不含 CLI，
 *  部署时需目标机设 AGENT_CLI_PATH 指向自备的 claude 二进制 */
const EMBEDDABLE_TARGETS: Record<string, string> = {
  'windows-x64': '@anthropic-ai/claude-agent-sdk-win32-x64',
  'linux-x64': '@anthropic-ai/claude-agent-sdk-linux-x64',
  'darwin-arm64': '@anthropic-ai/claude-agent-sdk-darwin-arm64',
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

  // 预检：交叉编译需目标平台的 CLI 包参与打包，而 bun install 按本机 OS 只装本机平台包
  // （实测 win32 机器只装 win32-x64），缺包时 bun 报笼统的 "Could not resolve"——
  // 此处提前给出精确安装指引。本机构建不受影响（死分支不解析，已实测）。
  const embedPkg = EMBEDDABLE_TARGETS[platformArch]
  if (embedPkg && !existsSync(join('node_modules', embedPkg))) {
    const { version: sdkVersion } = await Bun.file(
      'node_modules/@anthropic-ai/claude-agent-sdk/package.json',
    ).json()
    throw new Error(
      `交叉编译 ${target} 缺少目标平台 CLI 包 ${embedPkg}：\n` +
        `  bun add ${embedPkg}@${sdkVersion}\n` +
        '（仅构建期解析需要，构建完可还原 package.json / bun.lock）',
    )
  }
  if (!embedPkg) {
    say(`    注意：${platformArch} 变体不内嵌 CLI，产物需目标机设置 AGENT_CLI_PATH`)
  }

  // 只清理本目标旧产物与 sourcemap 残留，保留其他平台产物共存
  // （Windows 编译版由 bun 自动补 .exe 后缀，两种名字都要清）
  if (existsSync(OUT_DIR)) {
    for (const name of readdirSync(OUT_DIR)) {
      if (
        name === `app-${platformArch}-${version}` ||
        name === `app-${platformArch}-${version}.exe` ||
        name.endsWith('.map')
      ) {
        unlinkSync(join(OUT_DIR, name))
      }
    }
  }

  say('==> 构建前端（ui -> ui/dist）...')
  // BASE_URL 同时驱动 vite base（产物引用 /<base>/assets）——运行时后端读取同名变量挂载前缀，
  // 启动 exe 时须设置同样的 BASE_URL（默认根路径部署则都不设）
  if (process.env.BASE_URL) {
    say(`    子路径部署构建：BASE_URL=${process.env.BASE_URL}（启动时须设置相同值）`)
  }
  await $`cd ${UI_DIR} && bun run build`
  if (!existsSync(`${DIST_DIR}/index.html`)) {
    throw new Error('前端构建产物缺失：ui/dist/index.html')
  }

  say(`==> 编译可执行文件（target=${target}，内嵌前端 + 迁移）...`)
  // 注意1：compile 模式走 CLI（Bun.build API 的 compile 在编译产物落盘上不如 CLI 可靠）
  // 注意2：禁用 --bytecode——bun 1.4.0 下 bytecode 与 --asset 嵌入不兼容（嵌入失效），
  //        常驻 web 服务对冷启动不敏感；升级 bun 验证修复后可恢复
  // 注意3：--asset 按目录 basename 挂载到 bunfs 根（ui/dist -> dist/，migrations -> migrations/）
  // 注意4：WSL 规避——bun 1.4.0 在 WSL 上编译较大 bundle 会在写产物阶段崩溃
  //        （Error truncating ELF/PE file: EACCES ftruncate，与目标平台/文件系统无关），
  //        检测到 WSL 时编译步骤委托 Windows 侧同名 bun 执行（前端构建仍在当前端完成）
  const compileArgs = [
    'build',
    '--compile',
    '--minify',
    '--sourcemap=none',
    '--asset',
    `./${DIST_DIR}`,
    '--asset',
    `./${MIGRATIONS_SRC}`,
    '--target',
    target,
    '--outfile',
    `${OUT_DIR}/app-${platformArch}-${version}`,
    'src/index.ts',
  ]
  if (process.env.WSL_DISTRO_NAME) {
    say('    检测到 WSL：编译委托 Windows 侧 bun 执行（规避 WSL bun 产物写入崩溃）')
    await $`cmd.exe /c bun ${compileArgs}`
  } else {
    await $`bun ${compileArgs}`
  }

  removeSourcemaps(OUT_DIR)

  // Windows 编译版由 bun 自动补 .exe 后缀，这里探测实际产物名
  const exe = existsSync(`${OUT_DIR}/app-${platformArch}-${version}.exe`)
    ? `app-${platformArch}-${version}.exe`
    : `app-${platformArch}-${version}`

  say(`
打包完成。产物（bin/）：
  ${exe}  单文件可执行（内嵌 bun 运行时 + 前端页面 + 数据库迁移${embedPkg ? ' + claude CLI' : ''}，${embedPkg ? '约 275~320MB' : '约 100MB，需目标机设 AGENT_CLI_PATH'}）
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
