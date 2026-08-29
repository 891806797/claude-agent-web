import { Send, Square, X } from 'lucide-react'
import {
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { agentApi } from '@/lib/agent-api'
import type { SlashCommand } from '@/lib/agent-types'

interface PendingImage {
  dataUrl: string
  mime: string
  name: string
}

const ACCEPTED_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

/**
 * 输入框（受控）—— 文本态由父组件持有，便于文件树/命令注入。
 * Enter 发送、Shift+Enter 换行；turn 进行中显示「停止」；斜杠命令面板 + @mention 补全 +
 * 图片粘贴/拖拽。dock 样式（卡片化浮层）。
 */
export function PromptInput({
  value,
  onChange,
  onSend,
  onInterrupt,
  running,
  closed,
  commands,
  projectId
}: {
  value: string
  onChange: (v: string) => void
  onSend: (text: string, images?: Array<{ dataUrl: string; mime: string }>) => void
  onInterrupt: () => void
  running: boolean
  closed: boolean
  commands: SlashCommand[]
  projectId: string | null
}): React.JSX.Element {
  const { images, mentionFiles, removeImage, clearImages, onPaste, onDrop } = useImages(
    value,
    projectId
  )

  const cmdQuery = useMemo(() => {
    const m = value.match(/^\s*\/([^\s/]*)$/)
    if (!m) return null
    const q = m[1].toLowerCase()
    return commands.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 8)
  }, [value, commands])

  const submit = (): void => {
    const t = value.trim()
    if ((!t && images.length === 0) || closed) return
    onSend(
      t,
      images.length > 0 ? images.map(({ dataUrl, mime }) => ({ dataUrl, mime })) : undefined
    )
    onChange('')
    clearImages()
  }

  return (
    <div
      className="relative mx-2 mb-2 flex flex-col gap-1 rounded-lg border border-border bg-card p-2 shadow-sm"
      onDrop={onDrop}
    >
      {cmdQuery && cmdQuery.length > 0 && (
        <div className="absolute bottom-full left-0 right-0 mb-1 max-h-60 overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-md">
          {cmdQuery.map((c) => (
            <button
              key={c.name}
              type="button"
              onClick={() => onChange(`/${c.name} `)}
              className="flex w-full flex-col items-start gap-0.5 rounded px-2 py-1.5 text-left hover:bg-accent"
            >
              <span className="text-sm font-medium text-foreground">
                /{c.name}
                {c.argumentHint && <span className="text-muted-foreground"> {c.argumentHint}</span>}
              </span>
              <span className="text-xs text-muted-foreground">{c.description}</span>
            </button>
          ))}
        </div>
      )}

      {mentionFiles.length > 0 && (
        <div className="absolute bottom-full left-0 right-0 mb-1 max-h-60 overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-md">
          {mentionFiles.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => onChange(value.replace(/(@[^\s@]*)$/, `@${p} `))}
              className="block w-full truncate rounded px-2 py-1.5 text-left text-xs text-foreground hover:bg-accent"
            >
              {p}
            </button>
          ))}
        </div>
      )}

      {images.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {images.map((img, i) => (
            <div key={i} className="group relative">
              <img
                src={img.dataUrl}
                alt={img.name}
                className="size-16 rounded border border-border object-cover"
              />
              <button
                type="button"
                onClick={() => removeImage(i)}
                className="absolute -right-1.5 -top-1.5 flex size-4 items-center justify-center rounded-full bg-destructive text-destructive-foreground opacity-0 group-hover:opacity-100"
                aria-label="移除图片"
              >
                <X className="size-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-end gap-2">
        <Textarea
          value={value}
          onChange={(e: ChangeEvent<HTMLTextAreaElement>) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
          onPaste={onPaste}
          rows={1}
          placeholder={
            closed
              ? '会话已关闭，刷新或重新打开'
              : '发消息给 Claude…（Shift+Enter 换行，可粘贴图片，@ 提及文件）'
          }
          disabled={closed}
          className="max-h-48 resize-none border-0 bg-transparent p-1 focus-visible:ring-0"
        />
        {running ? (
          <Button variant="outline" size="icon" onClick={onInterrupt} aria-label="停止">
            <Square className="size-4" />
          </Button>
        ) : (
          <Button
            size="icon"
            onClick={submit}
            disabled={(!value.trim() && images.length === 0) || closed}
            aria-label="发送"
          >
            <Send className="size-4" />
          </Button>
        )}
      </div>
    </div>
  )
}

/** 图片 + @mention 文件状态（mention 检测在 hook 内统一处理） */
function useImages(value: string, projectId: string | null) {
  const [images, setImages] = useState<PendingImage[]>([])
  const [mentionFiles, setMentionFiles] = useState<string[]>([])
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined)

  const mentionQuery = useMemo(() => {
    const m = value.match(/(^|\s)@([^\s@]*)$/)
    return m ? m[2] : null
  }, [value])

  useEffect(() => {
    clearTimeout(debounceRef.current)
    if (mentionQuery === null || !projectId) {
      setMentionFiles([])
      return
    }
    debounceRef.current = setTimeout(() => {
      agentApi
        .getFiles(projectId, mentionQuery)
        .then(setMentionFiles)
        .catch(() => setMentionFiles([]))
    }, 200)
    return () => clearTimeout(debounceRef.current)
  }, [mentionQuery, projectId])

  const addFiles = (files: FileList | File[]) => {
    for (const f of Array.from(files)) {
      if (!ACCEPTED_MIME.has(f.type)) continue
      const reader = new FileReader()
      reader.onload = () => {
        const dataUrl = String(reader.result ?? '')
        if (dataUrl) setImages((prev) => [...prev, { dataUrl, mime: f.type, name: f.name }])
      }
      reader.readAsDataURL(f)
    }
  }

  return {
    images,
    mentionFiles,
    addFiles,
    removeImage: (i: number) => setImages((prev) => prev.filter((_, idx) => idx !== i)),
    clearImages: () => setImages([]),
    onPaste: (e: ClipboardEvent<HTMLTextAreaElement>) => {
      if (!e.clipboardData?.files?.length) return
      e.preventDefault()
      addFiles(e.clipboardData.files)
    },
    onDrop: (e: DragEvent<HTMLDivElement>) => {
      if (!e.dataTransfer?.files?.length) return
      e.preventDefault()
      addFiles(e.dataTransfer.files)
    }
  }
}
