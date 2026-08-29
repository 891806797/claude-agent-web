import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { env } from '@/env'

/**
 * 每用户 CLAUDE_CONFIG_DIR 管理——多用户会话数据的物理隔离边界。
 *
 * 两类使用方式：
 * 1. 会话子进程：query options.env 注入 userConfigDir(username)，子进程不受主进程 env 影响
 * 2. SDK 历史函数（listSessions/getSessionMessages/deleteSession/renameSession）：读的是
 *    process.env.CLAUDE_CONFIG_DIR（SDK 内部按 env 值 memoize），多用户并发必须经
 *    withUserConfigDir 互斥串行「设 env → 调用 → 还原」。
 *
 * 目录名用 encodeURIComponent(username)：输出仅 [A-Za-z0-9\-_.~%!*'()']，
 * 是文件系统安全字符集，且编码可逆唯一（中文名不会碰撞）。
 */

/** 每用户配置目录（<AGENT_CONFIG_ROOT>/<encodeURIComponent(username)>） */
export function userConfigDir(username: string): string {
  return resolve(env.AGENT_CONFIG_ROOT, encodeURIComponent(username))
}

/** openSession 前确保目录存在（SDK 子进程与历史函数都以它为根） */
export function ensureUserConfigDir(username: string): void {
  mkdirSync(userConfigDir(username), { recursive: true })
}

let chain: Promise<unknown> = Promise.resolve()

/**
 * 串行互斥执行需要切换 process.env.CLAUDE_CONFIG_DIR 的操作。
 * promise-chain 实现：同进程内所有调用按序执行，异常不断链。
 */
export function withUserConfigDir<T>(username: string, fn: () => Promise<T>): Promise<T> {
  const run = chain.then(async (): Promise<T> => {
    const prev = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = userConfigDir(username)
    try {
      return await fn()
    } finally {
      // 还原（undefined 必须显式 delete，直接赋值会产生字符串 "undefined"）
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = prev
    }
  })
  chain = run.catch(() => {})
  return run
}
