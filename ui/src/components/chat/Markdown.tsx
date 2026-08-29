import remarkGfm from 'remark-gfm'
import ReactMarkdown from 'react-markdown'
import { cn } from '@/lib/utils'

/**
 * 消息 Markdown 渲染 —— react-markdown + remark-gfm。
 * 不引入 @tailwind/typography（额外依赖），用 components 映射到语义 token 工具类，
 * 与 shadcn 主题一致（代码块 bg-muted、链接 text-primary、列表/标题常规）。
 * 流式安全：文本增量到达时整段重渲染，无副作用。
 */
export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn('text-sm leading-relaxed text-foreground', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
          h1: ({ children }) => <h1 className="mb-2 mt-3 text-base font-semibold">{children}</h1>,
          h2: ({ children }) => <h2 className="mb-2 mt-3 text-sm font-semibold">{children}</h2>,
          h3: ({ children }) => <h3 className="mb-1 mt-2 text-sm font-semibold">{children}</h3>,
          ul: ({ children }) => <ul className="mb-2 ml-4 list-disc space-y-0.5">{children}</ul>,
          ol: ({ children }) => <ol className="mb-2 ml-4 list-decimal space-y-0.5">{children}</ol>,
          li: ({ children }) => <li className="leading-relaxed">{children}</li>,
          a: ({ children, href }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary underline-offset-2 hover:underline"
            >
              {children}
            </a>
          ),
          strong: ({ children }) => (
            <strong className="font-semibold text-foreground">{children}</strong>
          ),
          em: ({ children }) => <em className="italic">{children}</em>,
          code: ({ className: cls, children }) => {
            const isBlock = /language-/.test(cls ?? '')
            if (isBlock) {
              return (
                <code className="block overflow-x-auto rounded bg-muted p-2 font-mono text-[12px] text-foreground">
                  {children}
                </code>
              )
            }
            return (
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-[12px] text-foreground">
                {children}
              </code>
            )
          },
          pre: ({ children }) => <pre className="mb-2">{children}</pre>,
          blockquote: ({ children }) => (
            <blockquote className="mb-2 border-l-2 border-border pl-3 text-muted-foreground">
              {children}
            </blockquote>
          ),
          table: ({ children }) => (
            <table className="mb-2 w-full border-collapse text-[12px]">{children}</table>
          ),
          th: ({ children }) => (
            <th className="border border-border px-2 py-1 text-left font-medium">{children}</th>
          ),
          td: ({ children }) => <td className="border border-border px-2 py-1">{children}</td>,
          hr: () => <hr className="my-2 border-border" />
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}
