import type { JSX } from 'react'
import { Toaster as SonnerToaster } from 'sonner'

// shadcn 官方 toast 方案 sonner 封装。sonner 是独立库（非 Radix），
// 与项目 Base UI 共存无冲突；自带 portal，全局 <Toaster /> 挂载一次即可。
export { toast } from 'sonner'

export function Toaster(): JSX.Element {
  return (
    <SonnerToaster
      position="bottom-right"
      richColors
      closeButton
      theme="system"
      toastOptions={{
        style: {
          fontSize: '13px',
          fontFamily: 'inherit'
        }
      }}
    />
  )
}
