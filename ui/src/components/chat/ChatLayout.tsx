import { useEffect } from 'react'
import { useCompactRequestStore } from '@/stores/compact-request'
import type { ChatAgentApi } from '@/hooks/useChatAgentApi'
import { ChatMessageList } from './ChatMessageList'

/**
 * 中栏卡片容器：会话/审批/输入区组成的一体化卡片（暖米白底、圆角浮起）。
 * agent 由 ChatPage 创建传入（web 版会话驱动、URL 恢复、占用接管均在 ChatPage）。
 */
export function ChatLayout({ agent }: { agent: ChatAgentApi }): React.JSX.Element {
  const compactNonce = useCompactRequestStore((s) => s.requestNonce)

  // 监听 CostCircle 发出的手动压缩请求 -> 发送 /compact（由 SDK 执行并回流 compaction 事件）
  useEffect(() => {
    if (compactNonce === 0) return
    agent.sendMessage('/compact')
  }, [compactNonce, agent.sendMessage])

  return (
    <div className="h-full min-h-0 flex flex-col bg-[var(--bg-deep)]">
      <div className="flex-1 min-h-0 p-2">
        <div className="h-full flex flex-col bg-[var(--bg-base)] rounded-[10px] overflow-hidden shadow-[var(--elevation-raised)]">
          <ChatMessageList agent={agent} />
        </div>
      </div>
    </div>
  )
}
