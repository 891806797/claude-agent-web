import { create } from 'zustand'

/**
 * 跨组件树的手动压缩请求通道。
 * CostCircle（ChatPage 顶栏）与发送层是兄弟节点，无共同 owner，
 * 故用此 store 解耦：CostCircle 调 requestCompact()，ChatLayout 订阅 requestNonce 变化
 * 后调 sendMessage('/compact')。nonce 模型避免重复触发（同一值只响应一次）。
 */
interface CompactRequestState {
  requestNonce: number
  requestCompact: () => void
}

export const useCompactRequestStore = create<CompactRequestState>((set) => ({
  requestNonce: 0,
  requestCompact: () => set((s) => ({ requestNonce: s.requestNonce + 1 }))
}))
