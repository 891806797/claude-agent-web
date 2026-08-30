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
 * - AGENT_CLI_PATH 显式指定：最高优先（未内嵌平台二进制的编译版逃生门——如
 *   linux-musl / darwin-x64 变体：部署机自备 CLI 并设置此变量）
 * - 编译版按平台解包内嵌 CLI（require 字面量让 bun build 追踪内嵌对应平台包；
 *   运行时仅命中本平台分支，缺失的平台包不阻断启动）：
 *   win32 -> cli-path.win32.ts、linux（glibc x64；arm64 无平台包分支，交叉编译内嵌
 *   x64 二进制在目标机必坏，故门控掉）-> cli-path.linux.ts、
 *   darwin-arm64 -> cli-path.darwin-arm64.ts
 * - dev / 未内嵌平台的编译版：返回 undefined，由 SDK 自行 require.resolve 定位
 *   node_modules 内的本平台二进制（optionalDependencies 按 OS 安装）
 */
let cached: string | undefined | null = null

export function getCliPath(): string | undefined {
  if (cached !== null) return cached ?? undefined
  let resolved: string | undefined
  if (env.AGENT_CLI_PATH) {
    resolved = env.AGENT_CLI_PATH
  } else if (Bun.isStandaloneExecutable) {
    // 平台 -> 内嵌模块映射（require 字面量保持静态可追踪，供 bun build 按目标平台内嵌）
    let mod: { default: string } | undefined
    if (process.platform === 'win32') {
      mod = require('./cli-path.win32.ts') as { default: string }
    } else if (process.platform === 'linux' && process.arch === 'x64') {
      mod = require('./cli-path.linux.ts') as { default: string }
    } else if (process.platform === 'darwin' && process.arch === 'arm64') {
      mod = require('./cli-path.darwin-arm64.ts') as { default: string }
    }
    if (mod) {
      try {
        resolved = extractFromBunfs(mod.default)
      } catch (err) {
        cached = null
        throw new Error(
          `${process.platform} 编译版解包 CLI 失败: ${err instanceof Error ? err.message : err}`,
        )
      }
    }
  }
  cached = resolved ?? null
  return resolved
}
