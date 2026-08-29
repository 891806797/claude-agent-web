import { type ChangeEvent, type FormEvent, useEffect, useState } from 'react'
import { Bot, Pencil, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { toast } from '@/components/ui/sonner'
import { agentApi, ApiError } from '@/lib/agent-api'
import type { Persona } from '@/lib/agent-types'

/**
 * 智能体定义管理页 —— 可复用人格（系统提示词）的增删改查。
 * systemPrompt 原文追加到 claude_code 预设后注入会话（所见即所得，不自动包装）；
 * 会话绑定存快照：此处修改/删除仅影响之后的新会话，已开会话与 resume 不受影响。
 */
export function PersonasPage(): React.JSX.Element {
  const [personas, setPersonas] = useState<Persona[]>([])
  const [deleting, setDeleting] = useState<Persona | null>(null)

  const refresh = (): void => {
    agentApi
      .listPersonas()
      .then(setPersonas)
      .catch(() => toast.error('加载智能体列表失败'))
  }

  useEffect(refresh, [])

  const remove = async (p: Persona): Promise<void> => {
    await agentApi.removePersona(p.id)
    toast.success(`已删除「${p.name}」`)
    setDeleting(null)
    refresh()
  }

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 md:p-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Bot className="size-4" />
            智能体定义（{personas.length}）
          </CardTitle>
          <CardDescription>维护可复用人格；聊天输入框选定后作为系统提示词注入会话</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <PersonaCreateForm onChanged={refresh} />
          {personas.length === 0 ? (
            <p className="text-sm text-muted-foreground">尚无智能体，先在上方创建一个</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {personas.map((p) => (
                <PersonaItem
                  key={p.id}
                  persona={p}
                  onChanged={refresh}
                  onRequestDelete={setDeleting}
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <DeleteDialog persona={deleting} onConfirm={remove} onClose={() => setDeleting(null)} />
    </main>
  )
}

// ===== 新建 =====

function PersonaCreateForm({ onChanged }: { onChanged: () => void }): React.JSX.Element {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    if (!name.trim() || !systemPrompt.trim()) return
    setBusy(true)
    try {
      await agentApi.createPersona({
        name: name.trim(),
        description: description.trim(),
        systemPrompt
      })
      setName('')
      setDescription('')
      setSystemPrompt('')
      toast.success('智能体已创建')
      onChanged()
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : '创建失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <div className="flex flex-col gap-2 sm:flex-row">
        <label className="flex flex-col gap-1 text-sm sm:w-48">
          <span className="text-muted-foreground">名称（唯一）</span>
          <Input
            value={name}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
            placeholder="代码审查专员"
            maxLength={50}
          />
        </label>
        <label className="flex flex-1 flex-col gap-1 text-sm">
          <span className="text-muted-foreground">描述（可选）</span>
          <Input
            value={description}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setDescription(e.target.value)}
            placeholder="专注代码质量与缺陷审查"
            maxLength={500}
          />
        </label>
      </div>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">系统提示词（追加到 Claude Code 预设后）</span>
        <Textarea
          value={systemPrompt}
          onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setSystemPrompt(e.target.value)}
          placeholder={
            '你是一名严谨的代码审查员……\n（原文注入，不自动包装；需要格式请自行写在提示词里）'
          }
          rows={5}
          maxLength={50000}
          className="font-mono text-[13px]"
        />
      </label>
      <div>
        <Button type="submit" size="sm" disabled={busy || !name.trim() || !systemPrompt.trim()}>
          {busy ? '创建中…' : '创建'}
        </Button>
      </div>
    </form>
  )
}

// ===== 列表项（展示 / 行内编辑）=====

function PersonaItem({
  persona,
  onChanged,
  onRequestDelete
}: {
  persona: Persona
  onChanged: () => void
  onRequestDelete: (p: Persona) => void
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(persona.name)
  const [description, setDescription] = useState(persona.description)
  const [systemPrompt, setSystemPrompt] = useState(persona.systemPrompt)
  const [busy, setBusy] = useState(false)

  const startEdit = (): void => {
    // 重置为服务端当前值（多次进出编辑不残留上次草稿）
    setName(persona.name)
    setDescription(persona.description)
    setSystemPrompt(persona.systemPrompt)
    setEditing(true)
  }

  const save = async (): Promise<void> => {
    if (!name.trim() || !systemPrompt.trim()) return
    setBusy(true)
    try {
      await agentApi.updatePersona(persona.id, {
        name: name.trim(),
        description: description.trim(),
        systemPrompt
      })
      toast.success('已保存（仅影响之后的新会话）')
      setEditing(false)
      onChanged()
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : '保存失败')
    } finally {
      setBusy(false)
    }
  }

  if (editing) {
    return (
      <li className="flex flex-col gap-2 rounded border bg-card px-3 py-2">
        <div className="flex flex-col gap-2 sm:flex-row">
          <label className="flex flex-col gap-1 text-sm sm:w-48">
            <span className="text-muted-foreground">名称</span>
            <Input
              value={name}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
              maxLength={50}
            />
          </label>
          <label className="flex flex-1 flex-col gap-1 text-sm">
            <span className="text-muted-foreground">描述</span>
            <Input
              value={description}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setDescription(e.target.value)}
              maxLength={500}
            />
          </label>
        </div>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">系统提示词</span>
          <Textarea
            value={systemPrompt}
            onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setSystemPrompt(e.target.value)}
            rows={5}
            maxLength={50000}
            className="font-mono text-[13px]"
          />
        </label>
        <div className="flex gap-2">
          <Button
            size="sm"
            disabled={busy || !name.trim() || !systemPrompt.trim()}
            onClick={() => void save()}
          >
            {busy ? '保存中…' : '保存'}
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => setEditing(false)}>
            取消
          </Button>
        </div>
      </li>
    )
  }

  return (
    <li className="flex items-start gap-2 rounded border bg-card px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-sm font-medium text-foreground">{persona.name}</span>
          {persona.description && (
            <span className="truncate text-xs text-muted-foreground">{persona.description}</span>
          )}
        </div>
        <p className="mt-0.5 line-clamp-2 whitespace-pre-wrap font-mono text-xs text-muted-foreground">
          {persona.systemPrompt}
        </p>
      </div>
      <Button size="sm" variant="ghost" onClick={startEdit} aria-label="编辑">
        <Pencil className="size-4" />
      </Button>
      <Button size="sm" variant="ghost" onClick={() => onRequestDelete(persona)} aria-label="删除">
        <Trash2 className="size-4 text-destructive" />
      </Button>
    </li>
  )
}

// ===== 删除确认 =====

function DeleteDialog({
  persona,
  onConfirm,
  onClose
}: {
  persona: Persona | null
  onConfirm: (p: Persona) => Promise<void>
  onClose: () => void
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  return (
    <Dialog
      open={persona !== null}
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogContent hideClose className="max-w-[400px]">
        <DialogHeader>
          <DialogTitle>删除智能体</DialogTitle>
          <DialogDescription>
            确定删除「{persona?.name}」？已开会话与历史 resume
            使用快照注入，不受影响；之后的新会话将不能再选它。
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" size="sm" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={busy}
            onClick={() => {
              if (!persona) return
              setBusy(true)
              void onConfirm(persona)
                .catch((err: unknown) => {
                  toast.error(err instanceof ApiError ? err.message : '删除失败')
                })
                .finally(() => {
                  setBusy(false)
                  onClose()
                })
            }}
          >
            {busy ? '删除中…' : '删除'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
