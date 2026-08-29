import { extractFromBunfs } from '@anthropic-ai/claude-agent-sdk/extract'
// file 导入：编译版把 claude.exe 嵌入 bunfs 并返回其虚拟路径；dev 返回真实路径（不使用）
import binPath from '@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe' with { type: 'file' }

/**
 * SDK 子进程二进制定位（编译打包专用）。
 *
 * 背景：`bun build --compile` 把应用打包成单文件 bunfs，SDK 运行时无法用
 * require.resolve 找到 claude.exe（README 明示）。需把平台二进制以 file asset 嵌入，
 * 运行时 extractFromBunfs 解包到真实临时路径，经 pathToClaudeCodeExecutable 显式传入。
 *
 * - 编译版（Bun.isStandaloneExecutable）：解包 bunfs 内嵌的 claude.exe，缓存后返回
 * - dev：返回 undefined，由 SDK 自行 require.resolve 定位 node_modules 内的二进制
 *
 * 仅内嵌 win32-x64 二进制（产品目标平台为 Windows；跨平台编译需另装对应平台包）。
 */
let cached: string | undefined | null = null

export function getCliPath(): string | undefined {
  if (cached !== null) return cached ?? undefined
  if (!Bun.isStandaloneExecutable) {
    cached = null
    return undefined
  }
  cached = extractFromBunfs(binPath)
  return cached
}
