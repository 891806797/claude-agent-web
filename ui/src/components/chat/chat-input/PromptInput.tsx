import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Attachment, Persona, SlashCommand } from '@/lib/agent-types'
import { agentApi } from '@/lib/agent-api'
import { ArrowUpIcon, FileIcon, SquareIcon, TerminalIcon, VenetianMaskIcon } from 'lucide-react'
import {
  createChipSpan,
  createImageChipSpan,
  extendRangeToAt,
  extendRangeToSlash,
  getChipBeforeCaret,
  getTextBeforeCaret,
  parseDOMToParts,
  partsToWire
} from './dom'
import type { FileSearchHit, ImageMime } from './types'
import { MentionPopover } from './MentionPopover'
import { CommandPopover } from './CommandPopover'
import { ModelSelectorPopover, type ModelItem } from './ModelSelectorPopover'

export interface PromptInputProps {
  isRunning: boolean
  /** 会话切换中（resume/openNew/切换智能体）：锁发送防竞态（消息打到正在替换的进程会蒸发） */
  isSwitchingSession: boolean
  commands: SlashCommand[]
  /** 当前项目 id（文件搜索数据源）；null 时禁用文件引用 */
  projectId?: string | null
  /** 当前选定的智能体（选中态；undefined = 标准 Claude） */
  personaId: string | undefined
  /** persona 显示名（'标准' = 标准 Claude） */
  personaLabel: string
  personas: Persona[]
  personasLoading: boolean
  /** persona 选择器禁用（会话运行中/切换中：运行中不可换脑，防审批悬空） */
  personaBusy: boolean
  /** persona 列表刷新（popover 打开时调用） */
  onOpenPersonas: () => void
  /** persona 选中（活会话且空闲 = 热切换，否则下次新会话生效；分流在上层） */
  onSelectPersona: (id: string | undefined) => void
  onSend: (message: string, attachments: Attachment[]) => void
  /** 中断当前进行中的 turn（保活会话） */
  onInterrupt: () => void
}

/** 粗指针（触屏）设备：Enter 换行、发送只走按钮（无物理键盘的 Enter 语义不可靠） */
function isCoarsePointer(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches
}

/** 高频常用命令白名单：空 query（刚输入 / 或点命令按钮）时排最前。
 * 用户最常找的内置命令；不在名单内的命令仍会显示（第二档），仅排序靠后。
 * CLI 升级新增高频命令按需补充。 */
const HIGH_FREQ_COMMANDS = new Set([
  'compact',
  'clear',
  'context',
  'model',
  'config',
  'mcp',
  'cost',
  'usage',
  'effort',
  'fast',
  'insights',
  'recap',
  'goal',
  'rename',
  'review',
  'security-review',
  'color',
  'init',
  'doctor',
  'agents',
  'memory',
  'permissions',
  'status',
  'help',
  'todos',
  'export',
  'hooks'
])

function scoreCmd(cmd: SlashCommand, q: string, isAlias: boolean): number {
  const name = cmd.name.toLowerCase()
  const base = isAlias ? 0.5 : 1
  if (!q) {
    // 空 query：常用内置命令（白名单）→ 子智能体/skill（无命名空间冒号）→ 插件命令（含冒号）
    if (HIGH_FREQ_COMMANDS.has(name)) return 3000 * base
    if (name.includes(':')) return 0
    return 1000 * base
  }
  if (name === q) return 2000 * base
  if (name.startsWith(q)) return (1000 - name.length) * base
  const idx = name.indexOf(q)
  if (idx > 0) return (600 - idx - name.length * 0.1) * base
  if (cmd.description.toLowerCase().includes(q)) return 100 * base
  return 0
}

function looksBinary(bytes: Uint8Array): boolean {
  const sample = bytes.length > 4096 ? bytes.subarray(0, 4096) : bytes
  let control = 0
  for (let i = 0; i < sample.length; i++) {
    const b = sample[i]
    if (b === 0) return true
    if (b < 0x09 || (b > 0x0d && b < 0x20)) control++
  }
  return sample.length > 0 && control / sample.length > 0.3
}

function normalizeImageMime(mime: string): ImageMime | null {
  const m = mime.toLowerCase()
  if (m === 'image/jpg') return 'image/jpeg'
  if (m === 'image/png' || m === 'image/jpeg' || m === 'image/gif' || m === 'image/webp')
    return m as ImageMime
  return null
}

function readAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

function basename(p: string): string {
  return p.split(/[/\\]/).pop() ?? p
}

export function PromptInput(props: PromptInputProps): React.JSX.Element {
  const {
    isRunning,
    isSwitchingSession,
    commands,
    projectId,
    personaId,
    personaLabel,
    personas,
    personasLoading,
    personaBusy,
    onOpenPersonas,
    onSelectPersona,
    onSend,
    onInterrupt
  } = props
  const rootRef = useRef<HTMLDivElement>(null)
  /** 输入框 + 三个 Popover 的外层容器：用于 outside click 关闭 Popover */
  const inputWrapRef = useRef<HTMLDivElement>(null)
  const composingRef = useRef(false)
  const searchSeqRef = useRef(0)
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [hasText, setHasText] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [mentionOpen, setMentionOpen] = useState(false)
  const [mentionResults, setMentionResults] = useState<FileSearchHit[]>([])
  const [mentionLoading, setMentionLoading] = useState(false)
  const [mentionActive, setMentionActive] = useState(0)
  /** 文件引用面板触发来源：'at'（输入 @ 触发，无搜索框）/ 'menu'（按钮触发，带搜索框） */
  const [mentionTrigger, setMentionTrigger] = useState<'at' | 'menu'>('at')
  const [mentionMenuQuery, setMentionMenuQuery] = useState('')
  const [commandOpen, setCommandOpen] = useState(false)
  /** 命令面板触发来源：'slash'（输入 / 触发，无搜索框）/ 'menu'（按钮触发，带搜索框） */
  const [commandTrigger, setCommandTrigger] = useState<'slash' | 'menu'>('slash')
  const [commandQuery, setCommandQuery] = useState('')
  const [commandMenuQuery, setCommandMenuQuery] = useState('')
  const [commandActive, setCommandActive] = useState(0)
  /** commandTrigger 的 ref 镜像：供 insertCommand 等回调读取最新值，避免闭包过期与频繁重建 */
  const commandTriggerRef = useRef<'slash' | 'menu'>('slash')
  const [personaOpen, setPersonaOpen] = useState(false)
  const [personaQuery, setPersonaQuery] = useState('')
  const [personaActive, setPersonaActive] = useState(0)

  const filteredCommands = useMemo(() => {
    // menu 模式 query 来自搜索框；slash 模式 query 取自输入框 caret 前文本
    const q = (commandTrigger === 'menu' ? commandMenuQuery : commandQuery).trim().toLowerCase()
    const cands: Array<{ cmd: SlashCommand; score: number }> = []
    for (const c of commands) {
      cands.push({ cmd: c, score: scoreCmd(c, q, false) })
      for (const a of c.aliases ?? []) {
        cands.push({ cmd: { ...c, name: a }, score: scoreCmd({ ...c, name: a }, q, true) })
      }
    }
    return cands
      .filter((x) => !q || x.score > 0 || x.cmd.name.toLowerCase().includes(q))
      .sort((a, b) => {
        // 同分时按字母序，使命令位置稳定可预测（空 query 下尤其重要）
        if (a.score !== b.score) return b.score - a.score
        return a.cmd.name.localeCompare(b.cmd.name)
      })
      .slice(0, 50)
      .map((x) => x.cmd)
  }, [commands, commandQuery, commandMenuQuery, commandTrigger])

  const personaItems = useMemo<ModelItem[]>(() => {
    const q = personaQuery.trim().toLowerCase()
    const matched = q
      ? personas.filter(
          (p) => p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q)
        )
      : personas
    return [
      { value: undefined, label: '标准 Claude', description: '不追加自定义系统提示词' },
      ...matched.map((p) => ({
        value: p.id,
        label: p.name,
        ...(p.description ? { description: p.description } : {})
      }))
    ]
  }, [personas, personaQuery])

  const adjustHasText = useCallback(() => {
    const root = rootRef.current
    if (!root) return
    const hasChip = root.querySelector('[data-mention],[data-image]') !== null
    setHasText((root.textContent ?? '').length > 0 || hasChip)
  }, [])

  const runSearch = useCallback(
    (query: string) => {
      if (!projectId) {
        setMentionResults([])
        return
      }
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
      searchTimerRef.current = setTimeout(async () => {
        const seq = ++searchSeqRef.current
        setMentionLoading(true)
        try {
          // 后端返回相对/绝对路径 string[]（空 q 返回全量），前端映射为 FileSearchHit
          const paths = await agentApi.getFiles(projectId, query)
          if (seq === searchSeqRef.current) {
            setMentionResults(
              paths
                .slice(0, 50)
                .map((p) => ({ path: p, name: basename(p), relativePath: p, score: 0 }))
            )
            setMentionActive(0)
          }
        } catch {
          if (seq === searchSeqRef.current) setMentionResults([])
        } finally {
          if (seq === searchSeqRef.current) setMentionLoading(false)
        }
      }, 80)
    },
    [projectId]
  )

  const detectTrigger = useCallback(() => {
    const root = rootRef.current
    if (!root) return
    const before = getTextBeforeCaret(root)
    const atMatch = before.match(/(?:^|\s)@([^\s@]*)$/)
    if (atMatch) {
      setMentionTrigger('at')
      setMentionOpen(true)
      setMentionActive(0)
      setCommandOpen(false)
      void runSearch(atMatch[1])
      return
    }
    const slashMatch = before.match(/(?:^|\n)\/([^\s/]*)$/)
    if (slashMatch) {
      setCommandTrigger('slash')
      setCommandOpen(true)
      setCommandQuery(slashMatch[1])
      setCommandActive(0)
      setMentionOpen(false)
      return
    }
    // 非 @/ 输入：仅 at 模式才关文件面板（menu 模式由搜索框/按钮自行管理，不误关）
    setCommandOpen(false)
    if (mentionTrigger === 'at') setMentionOpen(false)
  }, [runSearch, mentionTrigger])

  const handleInput = useCallback(
    (_e: React.SyntheticEvent) => {
      if (composingRef.current) return
      adjustHasText()
      detectTrigger()
    },
    [adjustHasText, detectTrigger]
  )

  const insertChipAtCaret = useCallback(
    (chip: HTMLElement): void => {
      const root = rootRef.current
      if (!root) return
      root.focus()
      const sel = window.getSelection()
      const space = document.createTextNode(' ')
      if (!sel || sel.rangeCount === 0 || !root.contains(sel.getRangeAt(0).endContainer)) {
        root.appendChild(chip)
        root.appendChild(space)
      } else {
        const range = sel.getRangeAt(0)
        range.deleteContents()
        range.insertNode(space)
        range.insertNode(chip)
        const nr = document.createRange()
        nr.setStartAfter(space)
        nr.collapse(true)
        sel.removeAllRanges()
        sel.addRange(nr)
      }
      adjustHasText()
    },
    [adjustHasText]
  )

  const insertTextAtCaret = useCallback(
    (text: string): void => {
      const root = rootRef.current
      if (!root) return
      root.focus()
      document.execCommand('insertText', false, text)
      adjustHasText()
    },
    [adjustHasText]
  )

  const addMention = useCallback(
    (hit: FileSearchHit): void => {
      const root = rootRef.current
      if (!root) return
      const sel = window.getSelection()
      if (!sel || sel.rangeCount === 0) return
      const range = sel.getRangeAt(0).cloneRange()
      if (!extendRangeToAt(range)) {
        insertChipAtCaret(createChipSpan(hit.path, hit.name))
        setMentionOpen(false)
        return
      }
      range.deleteContents()
      const chip = createChipSpan(hit.path, hit.name)
      const space = document.createTextNode(' ')
      range.insertNode(space)
      range.insertNode(chip)
      const nr = document.createRange()
      nr.setStartAfter(space)
      nr.collapse(true)
      sel.removeAllRanges()
      sel.addRange(nr)
      setMentionOpen(false)
      root.focus()
      adjustHasText()
    },
    [insertChipAtCaret, adjustHasText]
  )

  const submit = useCallback((): void => {
    const root = rootRef.current
    if (!root) return
    if (isSwitchingSession) return // 切换中锁发送（深防御：回车/按钮/命令自动提交统一兜底）
    const parts = parseDOMToParts(root)
    const { message, attachments } = partsToWire(parts)
    if (!message && attachments.length === 0) return
    onSend(message, attachments)
    root.replaceChildren()
    setMentionOpen(false)
    setCommandOpen(false)
    setHasText(false)
    root.focus()
  }, [onSend, isSwitchingSession])

  const insertCommand = useCallback(
    (cmd: SlashCommand): void => {
      const root = rootRef.current
      if (!root) return
      root.focus()
      const sel = window.getSelection()
      if (!sel || sel.rangeCount === 0) return

      if (commandTriggerRef.current === 'menu') {
        // menu 模式：清空输入框，填入 /name 作为新消息（点选即执行该命令的心智）
        root.replaceChildren()
        const text = document.createTextNode(`/${cmd.name} `)
        root.appendChild(text)
        const nr = document.createRange()
        nr.selectNodeContents(root)
        nr.collapse(false) // 光标到末尾
        sel.removeAllRanges()
        sel.addRange(nr)
      } else {
        // slash 模式：在 caret 处删除 /xxx 再插入 /name
        const range = sel.getRangeAt(0).cloneRange()
        if (extendRangeToSlash(range)) range.deleteContents()
        const text = document.createTextNode(`/${cmd.name} `)
        range.insertNode(text)
        const nr = document.createRange()
        nr.setStartAfter(text)
        nr.collapse(true)
        sel.removeAllRanges()
        sel.addRange(nr)
      }
      setCommandOpen(false)
      adjustHasText()
      root.focus()
      // slash 模式：无 args 命令选中即提交（对齐 Claude Code 原生输入 / 体验）；
      // menu 模式：填入输入框不提交，让用户在命令后补参/追加内容后手动发送（更透明）
      if (commandTriggerRef.current !== 'menu' && !cmd.argumentHint) {
        setTimeout(submit, 0)
      }
    },
    [adjustHasText, submit]
  )

  const selectPersonaItem = useCallback(
    (value: string | undefined): void => {
      onSelectPersona(value)
      setPersonaOpen(false)
      setPersonaQuery('')
      setPersonaActive(0)
      rootRef.current?.focus()
    },
    [onSelectPersona]
  )

  const openPersonaSelect = useCallback((): void => {
    setMentionOpen(false)
    setCommandOpen(false)
    setPersonaOpen(true)
    setPersonaQuery('')
    setPersonaActive(0)
    onOpenPersonas() // 打开即刷新（低频小列表永远新鲜）
  }, [onOpenPersonas])

  const openCommandMenu = useCallback((): void => {
    setMentionOpen(false)
    setPersonaOpen(false)
    setCommandTrigger('menu')
    setCommandMenuQuery('')
    setCommandActive(0)
    setCommandOpen(true)
  }, [])

  /** menu 模式搜索框文本变化：更新 query 并重置高亮项防越界 */
  const onCommandSearchQueryChange = useCallback((q: string): void => {
    setCommandMenuQuery(q)
    setCommandActive(0)
  }, [])

  /** menu 模式搜索框键盘导航：复用 commandOpen 分支的导航逻辑 */
  const onCommandSearchKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>): void => {
      if (!commandOpen) return
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setCommandActive((i) => (i + 1) % Math.max(filteredCommands.length, 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setCommandActive(
          (i) =>
            (i - 1 + Math.max(filteredCommands.length, 1)) % Math.max(filteredCommands.length, 1)
        )
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        const cmd = filteredCommands[commandActive]
        if (cmd) insertCommand(cmd)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setCommandOpen(false)
      }
    },
    [commandOpen, filteredCommands, commandActive, insertCommand]
  )

  const openFileMenu = useCallback((): void => {
    if (!projectId) return // 无项目不提供文件引用
    setCommandOpen(false)
    setPersonaOpen(false)
    setMentionTrigger('menu')
    setMentionMenuQuery('')
    setMentionActive(0)
    setMentionOpen(true)
    void runSearch('') // 列出全部前 50
  }, [projectId, runSearch])

  /** menu 模式文件搜索框文本变化：更新 query 并重置高亮项 */
  const onMentionSearchQueryChange = useCallback(
    (q: string): void => {
      setMentionMenuQuery(q)
      setMentionActive(0)
      void runSearch(q)
    },
    [runSearch]
  )

  /** menu 模式文件搜索框键盘导航：复用 mentionOpen 分支的导航逻辑 */
  const onMentionSearchKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>): void => {
      if (!mentionOpen) return
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setMentionActive((i) => (i + 1) % Math.max(mentionResults.length, 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setMentionActive(
          (i) => (i - 1 + Math.max(mentionResults.length, 1)) % Math.max(mentionResults.length, 1)
        )
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        const hit = mentionResults[mentionActive]
        if (hit) addMention(hit)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setMentionOpen(false)
      }
    },
    [mentionOpen, mentionResults, mentionActive, addMention]
  )

  const removeChipBeforeCaret = useCallback((): void => {
    const root = rootRef.current
    if (!root) return
    const chip = getChipBeforeCaret(root)
    if (chip) {
      chip.remove()
      adjustHasText()
    }
  }, [adjustHasText])

  const ingestDroppedFiles = useCallback(
    async (files: File[]): Promise<void> => {
      for (const file of files) {
        const mime = file.type
        if (mime.startsWith('image/')) {
          const normalized = normalizeImageMime(mime)
          if (!normalized) continue
          const dataUrl = await readAsDataURL(file)
          insertChipAtCaret(createImageChipSpan(dataUrl, file.name))
        } else {
          try {
            const buf = await file.arrayBuffer()
            const bytes = new Uint8Array(buf)
            if (looksBinary(bytes)) continue
            const limit = 10240
            const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, limit))
            insertTextAtCaret(text.length >= limit ? `${text}\n…[truncated]` : text)
          } catch {
            /* ignore unreadable */
          }
        }
      }
    },
    [insertChipAtCaret, insertTextAtCaret]
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>): void => {
      if (personaOpen && personaItems.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          setPersonaActive((i) => (i + 1) % personaItems.length)
          return
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          setPersonaActive((i) => (i - 1 + personaItems.length) % personaItems.length)
          return
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault()
          selectPersonaItem(personaItems[personaActive]?.value)
          return
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          setPersonaOpen(false)
          return
        }
      } else if (personaOpen) {
        if (e.key === 'Escape') {
          e.preventDefault()
          setPersonaOpen(false)
        }
      }
      if (mentionOpen && mentionResults.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          setMentionActive((i) => (i + 1) % mentionResults.length)
          return
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          setMentionActive((i) => (i - 1 + mentionResults.length) % mentionResults.length)
          return
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault()
          const hit = mentionResults[mentionActive]
          if (hit) addMention(hit)
          return
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          setMentionOpen(false)
          return
        }
      } else if (commandOpen && filteredCommands.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          setCommandActive((i) => (i + 1) % filteredCommands.length)
          return
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          setCommandActive((i) => (i - 1 + filteredCommands.length) % filteredCommands.length)
          return
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault()
          const cmd = filteredCommands[commandActive]
          if (cmd) insertCommand(cmd)
          return
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          setCommandOpen(false)
          return
        }
      } else if (mentionOpen || commandOpen) {
        if (e.key === 'Escape') {
          e.preventDefault()
          setMentionOpen(false)
          setCommandOpen(false)
        }
      }
      // 细指针（鼠标/触控板）：Enter 发送、Shift+Enter 换行；
      // 粗指针（触屏）：Enter 换行，发送只走按钮（软键盘 Enter 语义不可靠）
      if (e.key === 'Enter' && !e.shiftKey && !isCoarsePointer() && !isSwitchingSession) {
        e.preventDefault()
        submit()
        return
      }
      if (e.key === 'Escape' && isRunning) {
        e.preventDefault()
        onInterrupt()
      }
    },
    [
      personaOpen,
      personaItems,
      personaActive,
      selectPersonaItem,
      mentionOpen,
      mentionResults,
      mentionActive,
      commandOpen,
      filteredCommands,
      commandActive,
      addMention,
      insertCommand,
      submit,
      isRunning,
      isSwitchingSession,
      onInterrupt
    ]
  )

  const handlePaste = useCallback(
    (e: React.ClipboardEvent): void => {
      e.preventDefault()
      const cd = e.clipboardData
      if (cd.files && cd.files.length > 0) {
        void ingestDroppedFiles(Array.from(cd.files))
        return
      }
      const text = cd.getData('text/plain')
      if (text.startsWith('file:')) {
        const path = text.slice(5)
        insertChipAtCaret(createChipSpan(path, basename(path)))
        return
      }
      const imageItem = Array.from(cd.items).find((i) => i.type.startsWith('image/'))
      if (imageItem) {
        const f = imageItem.getAsFile()
        if (f) void ingestDroppedFiles([f])
        return
      }
      insertTextAtCaret(text)
    },
    [ingestDroppedFiles, insertChipAtCaret, insertTextAtCaret]
  )

  const handleDrop = useCallback(
    (e: React.DragEvent): void => {
      e.preventDefault()
      setDragOver(false)
      const internal = e.dataTransfer.getData('text/plain')
      if (internal.startsWith('file:')) {
        const path = internal.slice(5)
        insertChipAtCaret(createChipSpan(path, basename(path)))
        return
      }
      const files = Array.from(e.dataTransfer.files)
      if (files.length > 0) void ingestDroppedFiles(files)
    },
    [insertChipAtCaret, ingestDroppedFiles]
  )

  const handleDragOver = useCallback((e: React.DragEvent): void => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setDragOver(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent): void => {
    if (e.currentTarget === e.target) setDragOver(false)
  }, [])

  const handleBeforeInput = useCallback(
    (e: React.FormEvent<HTMLDivElement>): void => {
      const native = e.nativeEvent as InputEvent
      if (native.inputType === 'insertFromPaste') {
        e.preventDefault()
        return
      }
      if (native.inputType === 'deleteContentBackward') {
        const root = rootRef.current
        if (!root) return
        const sel = window.getSelection()
        if (sel && sel.isCollapsed && getChipBeforeCaret(root)) {
          e.preventDefault()
          removeChipBeforeCaret()
        }
      }
    },
    [removeChipBeforeCaret]
  )

  useEffect(() => {
    commandTriggerRef.current = commandTrigger
  }, [commandTrigger])

  useEffect(() => {
    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    }
  }, [])

  useEffect(() => {
    setMentionResults([])
    setMentionOpen(false)
  }, [projectId])

  // 点击输入框 + Popover 外部时关闭所有 Popover（智能体/命令/文件）
  useEffect(() => {
    const onPointerDown = (e: MouseEvent): void => {
      const wrap = inputWrapRef.current
      if (!wrap || wrap.contains(e.target as Node)) return
      setMentionOpen(false)
      setCommandOpen(false)
      setPersonaOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [])

  // 外部注入文件引用（FileTree 单击文件）：window 事件通道 → caret 处插入 @chip
  useEffect(() => {
    const onInsert = (e: Event): void => {
      const path = (e as CustomEvent<string>).detail
      if (!path) return
      rootRef.current?.focus()
      insertChipAtCaret(createChipSpan(path, basename(path)))
    }
    window.addEventListener('composer:insert', onInsert)
    return () => window.removeEventListener('composer:insert', onInsert)
  }, [insertChipAtCaret])

  return (
    <div className="shrink-0 px-4 pb-4 pt-2 max-md:pb-[max(0.75rem,env(safe-area-inset-bottom))] max-md:px-2.5">
      <div
        ref={inputWrapRef}
        className={[
          'rounded-[28px] border bg-[var(--bg-layer-01)] shadow-[0_2px_10px_rgba(0,0,0,0.05)] transition-all relative',
          dragOver
            ? 'border-primary shadow-[0_2px_16px_rgba(0,0,0,0.08)]'
            : 'border-[var(--border-base)] focus-within:border-ring focus-within:shadow-[0_2px_16px_rgba(0,0,0,0.08)]'
        ].join(' ')}
      >
        {dragOver && (
          <div className="absolute inset-0 z-30 grid place-items-center rounded-[28px] bg-[var(--bg-base)]/80 text-[14px] text-[var(--text-muted)] pointer-events-none">
            拖放以附加文件
          </div>
        )}
        <MentionPopover
          open={mentionOpen}
          results={mentionResults}
          loading={mentionLoading}
          activeIndex={mentionActive}
          onSelect={addMention}
          onHover={setMentionActive}
          searchMode={mentionTrigger === 'menu'}
          searchQuery={mentionMenuQuery}
          onSearchQueryChange={onMentionSearchQueryChange}
          onSearchKeyDown={onMentionSearchKeyDown}
        />
        <CommandPopover
          open={commandOpen}
          commands={filteredCommands}
          activeIndex={commandActive}
          onSelect={insertCommand}
          onHover={setCommandActive}
          searchMode={commandTrigger === 'menu'}
          searchQuery={commandMenuQuery}
          onSearchQueryChange={onCommandSearchQueryChange}
          onSearchKeyDown={onCommandSearchKeyDown}
        />
        <div className="px-5 pt-4 pb-1">
          <div
            ref={rootRef}
            contentEditable
            suppressContentEditableWarning
            role="textbox"
            aria-multiline="true"
            data-placeholder={isSwitchingSession ? '智能体切换中，请稍后输入' : '给助手发消息'}
            onInput={handleInput}
            onKeyDown={handleKeyDown}
            onCompositionStart={() => {
              composingRef.current = true
            }}
            onCompositionEnd={(e) => {
              composingRef.current = false
              handleInput(e)
            }}
            onPaste={handlePaste}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onBeforeInput={handleBeforeInput}
            className="prompt-editor w-full resize-none bg-transparent text-[15px] leading-6 text-[var(--text-base)] outline-none max-h-[200px] max-md:max-h-[35dvh] overflow-y-auto"
          />
        </div>
        <div className="relative flex items-center justify-between px-3 pb-2.5 pt-1">
          <ModelSelectorPopover
            open={personaOpen}
            loading={personasLoading}
            items={personaItems}
            selectedValue={personaId}
            query={personaQuery}
            activeIndex={personaActive}
            onSelect={selectPersonaItem}
            onQueryChange={setPersonaQuery}
            onHover={setPersonaActive}
            searchPlaceholder="搜索智能体…"
            loadingText="加载智能体中…"
            emptyText="暂无智能体（可在管理页创建）"
          />
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              onClick={openPersonaSelect}
              disabled={personaBusy}
              className="flex h-6 items-center gap-1 rounded-md px-2 text-[11px] text-[var(--text-muted)] transition-colors hover:bg-[var(--overlay-hover)] disabled:text-[var(--text-faint)] disabled:cursor-not-allowed disabled:hover:bg-transparent"
              title={
                personaBusy
                  ? '会话运行中，暂不能切换智能体'
                  : '选择智能体（空闲会话立即切换，新会话直接生效）'
              }
            >
              <VenetianMaskIcon className="size-3" />
              <span className="max-w-[120px] truncate">{personaLabel}</span>
            </button>
            <button
              type="button"
              onClick={openFileMenu}
              disabled={!projectId}
              className="flex h-6 items-center gap-1 rounded-md px-2 text-[11px] text-[var(--text-muted)] transition-colors hover:bg-[var(--overlay-hover)] disabled:text-[var(--text-faint)] disabled:cursor-not-allowed disabled:hover:bg-transparent"
              title="引用文件"
            >
              <FileIcon className="size-3" />
              <span>文件</span>
            </button>
            <button
              type="button"
              onClick={openCommandMenu}
              className="flex h-6 items-center gap-1 rounded-md px-2 text-[11px] text-[var(--text-muted)] transition-colors hover:bg-[var(--overlay-hover)]"
              title="选择命令"
            >
              <TerminalIcon className="size-3" />
              <span>命令</span>
            </button>
          </div>
          {isRunning ? (
            <button
              onClick={onInterrupt}
              className="size-8 flex items-center justify-center rounded-full bg-[var(--grey-100)] text-white transition-all hover:bg-red-500 hover:scale-105 active:scale-95"
              title="中断当前轮（Esc）"
            >
              <SquareIcon className="size-3 fill-current" />
            </button>
          ) : (
            <button
              onClick={submit}
              disabled={!hasText || isSwitchingSession}
              className="size-8 flex items-center justify-center rounded-full bg-[var(--grey-100)] text-white transition-all hover:bg-[var(--grey-50)] hover:scale-105 active:scale-95 disabled:bg-[var(--bg-layer-02)] disabled:text-[var(--text-faint)] disabled:hover:scale-100 disabled:cursor-not-allowed"
              title={isSwitchingSession ? '智能体切换中，请稍候' : '发送（Enter）'}
            >
              <ArrowUpIcon className="size-4" strokeWidth={2.5} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
