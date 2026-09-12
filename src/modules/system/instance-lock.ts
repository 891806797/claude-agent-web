import { unlinkSync } from 'node:fs'
import { platform, tmpdir } from 'node:os'
import { getLogger } from '@/core/logger'
import { handleDeepLink, openRoot } from './launch.service'
import { isUpdating } from './system.service'

/**
 * 单实例控制 socket —— 与 web PORT 解耦，PORT 被别的程序占用也能判断主实例在否。
 *
 * 控制通道：Bun unix socket —— win 为命名管 \\.\pipe\csm-coding-agent-web，
 *          posix 为 ${tmpdir()}/csm-coding-agent-web.sock。
 * 冷启动：connect 不上 = 无主 → listen 抢 socket（stale 拒留先 unlink）→ 返回 primary。
 * 热启动：connect 成功 = 主在 → 写帧 → 200ms 后退出；主实例 listen 回调收帧分发。
 */

const logger = getLogger('system-instance-lock')

export type Frame = { kind: 'deep-link'; url: string } | { kind: 'open'; user: string }

function controlSocketPath(): string {
  return platform() === 'win32'
    ? `\\\\.\\pipe\\csm-coding-agent-web`
    : `${tmpdir()}/csm-coding-agent-web.sock`
}

// ===== 主实例：收帧分发 =====

let frameHandler: ((frame: Frame) => void) | null = null
const pending: Frame[] = []

function enqueue(frame: Frame): void {
  if (frameHandler) frameHandler(frame)
  else pending.push(frame)
}

/** index.ts 在服务就绪后注册实时帧处理器，并冲刷此前的 pending 帧 */
export function setFrameHandler(fn: (frame: Frame) => void): void {
  frameHandler = fn
  while (pending.length > 0) fn(pending.shift()!)
}

export function dispatch(frame: Frame): void {
  if (isUpdating()) {
    logger.warn({ frame }, '更新中，忽略转发帧')
    return
  }
  // deep-link bootstrap 失败不拖垮主实例（仅记日志；用户重点一次即冷启）
  if (frame.kind === 'deep-link') {
    handleDeepLink(frame.url).catch((err) => {
      logger.error({ err, url: frame.url }, 'deep-link bootstrap 失败')
    })
  } else {
    try {
      openRoot(frame.user)
    } catch (err) {
      logger.error({ err, user: frame.user }, 'openRoot 失败')
    }
  }
}

function startListen(path: string): void {
  Bun.listen({
    unix: path,
    socket: {
      data: (_socket, data) => {
        const text = typeof data === 'string' ? data : new TextDecoder().decode(data)
        for (const line of text.split('\n')) {
          const trimmed = line.trim()
          if (!trimmed) continue
          try {
            enqueue(JSON.parse(trimmed) as Frame)
          } catch (err) {
            logger.warn({ err, line: trimmed }, '控制帧解析失败')
          }
        }
      },
      error: (_socket, err) => logger.error({ err }, '控制 socket 错误'),
    },
  })
  logger.info({ path }, '控制 socket 已监听（主实例）')
}

// ===== acquireOrForward =====

/**
 * 返回 'primary' 表示当前进程应作为主实例继续起服务；
 * 返回 'forwarded' 表示帧已转给主实例，当前进程应 exit(0)。
 * frame 为 null（后台无意图：系统自启）时，主实例在则静默退出，不写帧不开浏览器。
 */
export function acquireOrForward(frame: Frame | null): Promise<'primary' | 'forwarded'> {
  const path = controlSocketPath()
  return new Promise((resolve) => {
    let settled = false
    const fail = () => {
      if (settled) return
      settled = true
      // 无主实例 → 抢 listen 成为 primary
      try {
        startListen(path)
        resolve('primary')
      } catch (err) {
        // posix：主实例崩溃后 socket 文件拒留，unlink 后重试一次
        logger.warn({ err, path }, 'listen 失败，尝试清理 stale socket')
        try {
          unlinkSync(path)
          startListen(path)
          resolve('primary')
        } catch (err2) {
          logger.error({ err: err2, path }, '控制 socket listen 终失败')
          // 无法单实例化，仍作为 primary 起 web 服务（功能降级，转发失效但服务可用）
          resolve('primary')
        }
      }
    }
    try {
      const sock = Bun.connect({
        unix: path,
        socket: {
          open: (s) => {
            if (frame) s.write(`${JSON.stringify(frame)}\n`)
            s.flush()
            // 给主实例 200ms 读取帧，再退出
            setTimeout(() => {
              if (settled) return
              settled = true
              s.end()
              logger.info({ frame }, '帧已转发给主实例')
              resolve('forwarded')
            }, 200)
          },
          error: () => fail(),
        },
      })
      // 兜底超时：connect 立即 fail 的场景由 error 覆盖；其余 500ms 内必须决断
      setTimeout(fail, 500)
      void sock
    } catch {
      fail()
    }
  })
}
