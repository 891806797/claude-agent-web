import { extractFromBunfs } from '@anthropic-ai/claude-agent-sdk/extract'
import { env } from '@/env'

/**
 * SDK 子进程二进制定位（编译打包专用）。
 *
 * 背景：`bun build --compile` 把应用打包成单文件 bunfs，SDK 运行时无法用
 * require.resolve 找到 CLI 二进制（README 明示）。需把平台二进制以 file asset 嵌入，
 * 运行时 extractFromBunfs 解包到真实临时路径，经 pathToClaudeCodeExecutable 显式传入。
 *
 * 平台适配（file import 必须静态，平台包又按 OS 安装，故按平台分治）：
 * - AGENT_CLI_PATH 显式指定：最高优先（非 Windows 平台编译版的逃生门——bunfs 未内嵌
 *   对应平台二进制时，部署机自备 CLI 并设置此变量）
 * - Windows 编译版：require ./cli-path.win32.ts 解包内嵌的 claude.exe
 *   （require 字面量让 bun build 追踪内嵌；非 win32 平台不加载该模块，缺失包不阻断启动）
 * - dev / 其余平台编译版：返回 undefined，由 SDK 自行 require.resolve 定位
 *   node_modules 内的本平台二进制（optionalDependencies 按 OS 安装）
 */
let cached: string | undefined | null = null

export function getCliPath(): string | undefined {
  if (cached !== null) return cached ?? undefined
  let resolved: string | undefined
  if (env.AGENT_CLI_PATH) {
    resolved = env.AGENT_CLI_PATH
  } else if (Bun.isStandaloneExecutable && process.platform === 'win32') {
    try {
      const { default: binPath } = require('./cli-path.win32.ts') as { default: string }
      resolved = extractFromBunfs(binPath)
    } catch (err) {
      cached = null
      throw new Error(
        `win32 编译版解包 claude.exe 失败: ${err instanceof Error ? err.message : err}`,
      )
    }
  }
  cached = resolved ?? null
  return resolved
}
