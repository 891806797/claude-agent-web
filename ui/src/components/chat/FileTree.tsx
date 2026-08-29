import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Braces,
  ChevronRight,
  FileCode,
  FileCog,
  FileImage,
  FileJson,
  FileText,
  FileType,
  Folder,
  Search
} from 'lucide-react'
import { agentApi } from '@/lib/agent-api'
import type { FileSearchHit } from './chat-input/types'

interface FileEntry {
  name: string
  path: string
  isDir: boolean
  children: FileEntry[]
}

type IconType = React.ComponentType<{ className?: string }>

function getFileIconInfo(name: string): { Icon: IconType; color: string } {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  if (ext === 'ts' || ext === 'tsx') return { Icon: FileCode, color: 'text-blue-500' }
  if (ext === 'js' || ext === 'jsx' || ext === 'mjs' || ext === 'cjs')
    return { Icon: FileCode, color: 'text-yellow-500' }
  if (ext === 'json') return { Icon: FileJson, color: 'text-green-500' }
  if (ext === 'md' || ext === 'mdx' || ext === 'txt')
    return { Icon: FileText, color: 'text-[var(--text-faint)]' }
  if (ext === 'css' || ext === 'scss' || ext === 'less' || ext === 'sass')
    return { Icon: Braces, color: 'text-blue-400' }
  if (ext === 'html' || ext === 'htm' || ext === 'xml' || ext === 'svg')
    return { Icon: FileCode, color: 'text-orange-500' }
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp'].includes(ext))
    return { Icon: FileImage, color: 'text-purple-500' }
  if (ext === 'py') return { Icon: FileCode, color: 'text-green-600' }
  if (ext === 'go' || ext === 'rs') return { Icon: FileCode, color: 'text-orange-400' }
  if (ext === 'java' || ext === 'kt') return { Icon: FileCode, color: 'text-red-500' }
  if (ext === 'yml' || ext === 'yaml' || ext === 'toml' || ext === 'ini' || ext === 'env')
    return { Icon: FileCog, color: 'text-rose-400' }
  if (ext === 'sh' || ext === 'bash' || ext === 'zsh')
    return { Icon: FileCode, color: 'text-green-400' }
  if (ext === 'lock') return { Icon: FileCog, color: 'text-[var(--text-faint)]' }
  return { Icon: FileType, color: 'text-[var(--text-faint)]' }
}

function FileIcon({ name, isDir }: { name: string; isDir: boolean }): React.JSX.Element {
  if (isDir) return <Folder className="size-3.5 text-yellow-500/80 shrink-0" />
  const { Icon, color } = getFileIconInfo(name)
  return <Icon className={`size-3.5 ${color} shrink-0`} />
}

function buildTree(paths: string[]): FileEntry[] {
  const root: FileEntry[] = []
  for (const p of paths) {
    const parts = p.split('/')
    let level = root
    let acc = ''
    parts.forEach((part, i) => {
      acc = acc ? `${acc}/${part}` : part
      const isDir = i < parts.length - 1
      let node = level.find((n) => n.name === part)
      if (!node) {
        node = { name: part, path: acc, isDir, children: [] }
        level.push(node)
      }
      level = node.children
    })
  }
  const sort = (nodes: FileEntry[]) => {
    nodes.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))
    nodes.forEach((n) => sort(n.children))
  }
  sort(root)
  return root
}

/** 单击文件 → 注入 composer @chip（PromptInput 监听 window 'composer:insert' 事件） */
function insertToComposer(path: string): void {
  window.dispatchEvent(new CustomEvent<string>('composer:insert', { detail: path }))
}

function TreeNode({ entry, depth }: { entry: FileEntry; depth: number }): React.JSX.Element {
  const [expanded, setExpanded] = useState(depth < 1)
  // web 一次拉全量构建树（后端有界遍历），目录子节点已预置，无懒加载
  if (entry.isDir) {
    return (
      <div>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-1.5 w-full h-6 px-1.5 rounded-md text-left transition-colors duration-75 hover:bg-[var(--overlay-hover)] text-[12px] text-[var(--text-muted)]"
          style={{ paddingLeft: 8 + depth * 12 }}
        >
          <ChevronRight
            className={[
              'size-3 shrink-0 text-[var(--text-faint)] transition-transform',
              expanded && 'rotate-90'
            ].join(' ')}
          />
          <FileIcon name={entry.name} isDir />
          <span className="truncate flex-1">{entry.name}</span>
        </button>
        {expanded && entry.children.length > 0 && (
          <div>
            {entry.children.map((c) => (
              <TreeNode key={c.path} entry={c} depth={depth + 1} />
            ))}
          </div>
        )}
        {expanded && entry.children.length === 0 && (
          <div
            className="text-[11px] text-[var(--text-faint)] py-1"
            style={{ paddingLeft: 8 + (depth + 1) * 12 + 16 }}
          >
            空目录
          </div>
        )}
      </div>
    )
  }
  return (
    <button
      type="button"
      draggable
      onClick={() => insertToComposer(entry.path)}
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', 'file:' + entry.path)
        e.dataTransfer.effectAllowed = 'copyMove'
      }}
      className="flex items-center gap-1.5 w-full h-6 px-1.5 rounded-md text-left transition-colors duration-75 hover:bg-[var(--overlay-hover)] text-[12px] text-[var(--text-muted)]"
      style={{ paddingLeft: 8 + depth * 12 + 12 }}
      title={`引用 ${entry.path}`}
    >
      <span className="w-3 shrink-0" />
      <FileIcon name={entry.name} isDir={false} />
      <span className="truncate flex-1">{entry.name}</span>
    </button>
  )
}

export function FileTree({ projectId }: { projectId: string | null }): React.JSX.Element {
  const [tree, setTree] = useState<FileEntry[]>([])
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<FileSearchHit[]>([])
  const [searching, setSearching] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const searchSeq = useRef(0)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])

  useEffect(() => {
    if (!projectId) {
      setTree([])
      return
    }
    agentApi
      .getFiles(projectId, '')
      .then((files) => setTree(buildTree(files)))
      .catch(() => setTree([]))
  }, [projectId])

  // 文件搜索（防抖 + 竞态守卫），同 PromptInput 的 @ 搜索数据源
  useEffect(() => {
    const q = query.trim()
    if (!q || !projectId) return
    const t = setTimeout(async () => {
      const seq = ++searchSeq.current
      setSearching(true)
      try {
        const paths = await agentApi.getFiles(projectId, q)
        if (seq === searchSeq.current) {
          setResults(
            paths.slice(0, 50).map((p) => {
              const name = p.split('/').pop() ?? p
              return { path: p, name, relativePath: p, score: 0 }
            })
          )
          setActiveIndex(0)
        }
      } catch {
        if (seq === searchSeq.current) setResults([])
      } finally {
        if (seq === searchSeq.current) setSearching(false)
      }
    }, 80)
    return () => clearTimeout(t)
  }, [query, projectId])

  useEffect(() => {
    itemRefs.current[activeIndex]?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, results])

  const handleSearchKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>): void => {
      if (results.length === 0) {
        if (e.key === 'Escape') setQuery('')
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActiveIndex((i) => (i + 1) % results.length)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveIndex((i) => (i - 1 + results.length) % results.length)
      } else if (e.key === 'Enter') {
        e.preventDefault()
        const hit = results[activeIndex]
        if (hit) {
          insertToComposer(hit.path)
          setQuery('')
          setResults([])
        }
      } else if (e.key === 'Escape') {
        e.preventDefault()
        setQuery('')
      }
    },
    [results, activeIndex]
  )

  const q = query.trim()
  const emptyTree = useMemo(() => tree.length === 0, [tree])

  return (
    <div className="h-full flex flex-col">
      <div className="p-2 border-b border-[var(--border-muted)] shrink-0">
        <div className="flex items-center gap-1.5 rounded-md bg-[var(--bg-layer-01)] px-2 py-1.5">
          <Search className="size-3.5 text-[var(--text-faint)] shrink-0" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            placeholder="搜索文件…（Enter 引用）"
            spellCheck={false}
            className="flex-1 bg-transparent text-[12px] text-[var(--text-base)] placeholder:text-[var(--text-faint)] outline-none"
          />
          {searching && q && (
            <span className="size-3 rounded-full border border-[var(--text-faint)] border-t-transparent animate-spin shrink-0" />
          )}
        </div>
        {q && !searching && (
          <div className="mt-1 px-1 text-[11px] text-[var(--text-faint)]">
            {results.length > 0
              ? `找到 ${results.length} 个文件 · ↑↓ 选择 · Enter 引用`
              : '无匹配文件'}
          </div>
        )}
      </div>
      <div className="flex-1 overflow-y-auto select-none">
        {!projectId ? (
          <div className="p-4 text-center text-[12px] text-[var(--text-faint)]">请先选择项目</div>
        ) : q ? (
          <div className="py-1">
            {results.map((hit, i) => (
              <button
                key={hit.path}
                type="button"
                draggable
                ref={(el) => {
                  itemRefs.current[i] = el
                }}
                onMouseEnter={() => setActiveIndex(i)}
                onClick={() => {
                  insertToComposer(hit.path)
                  setQuery('')
                  setResults([])
                }}
                onDragStart={(e) => {
                  e.dataTransfer.setData('text/plain', 'file:' + hit.path)
                  e.dataTransfer.effectAllowed = 'copyMove'
                }}
                className={[
                  'flex items-center gap-1.5 w-full h-6 px-2 rounded-md text-left transition-colors text-[12px] text-[var(--text-muted)]',
                  i === activeIndex
                    ? 'bg-[var(--overlay-hover)]'
                    : 'hover:bg-[var(--overlay-hover)]'
                ].join(' ')}
              >
                <FileIcon name={hit.name} isDir={false} />
                <span className="truncate shrink-0 max-w-[45%]">{hit.name}</span>
                <span className="text-[11px] text-[var(--text-faint)] truncate flex-1 text-right">
                  {hit.relativePath}
                </span>
              </button>
            ))}
          </div>
        ) : emptyTree ? (
          <div className="p-4 text-center text-[12px] text-[var(--text-faint)]">目录为空</div>
        ) : (
          <div className="py-1">
            {tree.map((entry) => (
              <TreeNode key={entry.path} entry={entry} depth={0} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
