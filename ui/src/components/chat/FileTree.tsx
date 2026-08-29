import { ChevronRight, File, Folder } from 'lucide-react'
import { useEffect, useState } from 'react'
import { agentApi } from '@/lib/agent-api'
import { cn } from '@/lib/utils'

/**
 * 文件树（右抽屉）—— 从 getFiles 拉项目文件清单（有界遍历，已缓存于后端），
 * 按目录构建嵌套树。点击文件 → onInsertPath(@path) 注入输入框。
 */
interface TreeNode {
  name: string
  path: string
  isDir: boolean
  children: TreeNode[]
}

function buildTree(paths: string[]): TreeNode[] {
  const root: TreeNode[] = []
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
  // 目录优先排序
  const sort = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))
    nodes.forEach((n) => sort(n.children))
  }
  sort(root)
  return root
}

export function FileTree({
  projectId,
  onInsertPath
}: {
  projectId: string | null
  onInsertPath: (path: string) => void
}): React.JSX.Element {
  const [tree, setTree] = useState<TreeNode[]>([])

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

  return (
    <div className="flex h-full flex-col bg-card">
      <div className="border-b border-border px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        文件
      </div>
      <div className="flex-1 overflow-y-auto p-1">
        {tree.length === 0 ? (
          <p className="px-2 py-1 text-xs text-muted-foreground">无文件或未选择项目</p>
        ) : (
          tree.map((n) => <TreeRow key={n.path} node={n} depth={0} onInsertPath={onInsertPath} />)
        )}
      </div>
    </div>
  )
}

function TreeRow({
  node,
  depth,
  onInsertPath
}: {
  node: TreeNode
  depth: number
  onInsertPath: (path: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(depth < 1)
  if (node.isDir) {
    return (
      <div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-xs hover:bg-accent"
          style={{ paddingLeft: depth * 12 + 4 }}
        >
          <ChevronRight
            className={cn('size-3 shrink-0 text-muted-foreground', open && 'rotate-90')}
          />
          <Folder className="size-3 shrink-0 text-muted-foreground" />
          <span className="truncate text-foreground">{node.name}</span>
        </button>
        {open &&
          node.children.map((c) => (
            <TreeRow key={c.path} node={c} depth={depth + 1} onInsertPath={onInsertPath} />
          ))}
      </div>
    )
  }
  return (
    <button
      type="button"
      onClick={() => onInsertPath(node.path)}
      className="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-xs hover:bg-accent"
      style={{ paddingLeft: depth * 12 + 4 }}
    >
      <span className="size-3 shrink-0" />
      <File className="size-3 shrink-0 text-muted-foreground" />
      <span className="truncate text-muted-foreground">{node.name}</span>
    </button>
  )
}
