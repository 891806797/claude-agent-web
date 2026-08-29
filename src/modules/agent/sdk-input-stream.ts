import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'

/**
 * 单消费者 push-based 异步队列，包装为 AsyncIterable<SDKUserMessage>。
 * 用作 streaming input 模式下 query({ prompt: stream }) 的输入源——
 * 外部 push 带 uuid 的 user message，SDK 内部 for-await 拉取。
 *
 * 关闭语义：不暴露主动 close。监听会话 AbortSignal——abort 时让 iterator
 * 自然 return（done=true），由 SDK 走优雅拆除（关 stdin → 2s 优雅窗口 → SIGKILL）。
 * registry 关闭会话只需 abortController.abort()，无需也无法"撤销已 push 的消息"。
 *
 * 移植自 claude-agent-desktop（probe 实测：push 顺序 = SDK 消费顺序，FIFO 可靠）。
 */
export class SdkInputStream {
  private buffer: SDKUserMessage[] = []
  private waiters: Array<(r: IteratorResult<SDKUserMessage>) => void> = []
  private aborted = false

  constructor(abortSignal: AbortSignal) {
    const onAbort = (): void => {
      if (this.aborted) return
      this.aborted = true
      // 唤醒所有挂起的消费者，让它们 resolve done=true → iterator 自然结束
      const ws = this.waiters.splice(0)
      for (const w of ws) w({ done: true, value: undefined })
    }
    if (abortSignal.aborted) onAbort()
    else abortSignal.addEventListener('abort', onAbort, { once: true })
  }

  /** push 一条带 uuid 的 user message。abort 后静默丢弃（会话已在拆除） */
  push(msg: SDKUserMessage): void {
    if (this.aborted) return
    const waiter = this.waiters.shift()
    if (waiter) waiter({ done: false, value: msg })
    else this.buffer.push(msg)
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    const self = this
    return {
      next(): Promise<IteratorResult<SDKUserMessage>> {
        // buffer 优先（保证 FIFO）
        if (self.buffer.length > 0) {
          const value = self.buffer.shift() as SDKUserMessage
          return Promise.resolve({ done: false, value })
        }
        if (self.aborted) {
          return Promise.resolve({ done: true, value: undefined })
        }
        // 无消息且未 abort：挂起，等 push 或 abort 唤醒
        return new Promise((resolve) => self.waiters.push(resolve))
      },
    }
  }
}
