import { type ChangeEvent, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { ApprovalResolution } from '@/components/chat/ApprovalCard'
import type { PendingApproval } from '@/lib/agent-types'

/** Other 选项哨兵；提交时替换为用户实际输入文本 */
const OTHER_VALUE = '__other__'

interface QOption {
  label: string
  description?: string
}
interface Question {
  question: string
  header?: string
  options: QOption[]
  multiSelect?: boolean
}

/**
 * AskUserQuestion 问卷卡 —— 多题 / 单选·多选 / Other 自由输入 / notes。
 * 单题单选非 Other 即自动提交（对齐 CLI/desktop 行为）；多题或多选走提交回顾。
 * 作答回传：updatedInput = {...原 input（questions 原样保留），answers, annotations}。
 * 服务端 buildQuestionnaireInput 校验每题必答 + questions 不可改。
 */
export function AskUserQuestionApproval({
  approval,
  onResolve
}: {
  approval: PendingApproval
  onResolve: (r: ApprovalResolution) => void
}): React.JSX.Element {
  const questions = ((approval.input as { questions?: Question[] }).questions ?? []) as Question[]
  const isAuto = questions.length === 1 && !questions[0]?.multiSelect

  const [single, setSingle] = useState<Record<string, string>>({})
  const [multi, setMulti] = useState<Record<string, Set<string>>>({})
  const [otherText, setOtherText] = useState<Record<string, string>>({})
  const [notes, setNotes] = useState<Record<string, string>>({})

  const buildAnswers = (): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const q of questions) {
      if (q.multiSelect) {
        const sel = multi[q.question]
        if (sel && sel.size > 0) {
          const labels = Array.from(sel)
            .filter((v) => v !== OTHER_VALUE)
            .concat(
              sel.has(OTHER_VALUE) && otherText[q.question]?.trim()
                ? [otherText[q.question].trim()]
                : sel.has(OTHER_VALUE)
                  ? [OTHER_VALUE]
                  : []
            )
          out[q.question] = labels.join(', ')
        }
      } else {
        const sel = single[q.question]
        if (sel) {
          out[q.question] = sel === OTHER_VALUE ? otherText[q.question]?.trim() || OTHER_VALUE : sel
        }
      }
    }
    return out
  }

  const allAnswered = questions.every((q) => {
    if (q.multiSelect) return (multi[q.question]?.size ?? 0) > 0
    const sel = single[q.question]
    return sel && !(sel === OTHER_VALUE && !otherText[q.question]?.trim())
  })

  const submit = (answers: Record<string, string>): void => {
    const annotations: Record<string, { notes?: string }> = {}
    for (const q of questions) {
      const n = notes[q.question]?.trim()
      if (n) annotations[q.question] = { notes: n }
    }
    onResolve({
      allowed: true,
      updatedInput: {
        ...approval.input,
        answers,
        ...(Object.keys(annotations).length ? { annotations } : {})
      }
    })
  }

  const onRadio = (question: string, value: string): void => {
    setSingle((p) => ({ ...p, [question]: value }))
    if (isAuto && value !== OTHER_VALUE) {
      const answers: Record<string, string> = { [question]: value }
      const annotations: Record<string, { notes?: string }> = {}
      const n = notes[question]?.trim()
      if (n) annotations[question] = { notes: n }
      onResolve({
        allowed: true,
        updatedInput: {
          ...approval.input,
          answers,
          ...(Object.keys(annotations).length ? { annotations } : {})
        }
      })
    }
  }

  const toggleMulti = (question: string, label: string, checked: boolean): void => {
    setMulti((p) => {
      const cur = new Set(p[question] ?? [])
      if (checked) cur.add(label)
      else cur.delete(label)
      return { ...p, [question]: cur }
    })
  }

  const dismiss = (): void => onResolve({ allowed: false, feedback: '用户拒绝回答' })

  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-card p-3 shadow-sm">
      <div className="flex items-center gap-2">
        <Badge variant="secondary">AskUserQuestion</Badge>
        <span className="text-xs text-muted-foreground">需回答 {questions.length} 个问题</span>
      </div>

      {questions.map((q) => (
        <div key={q.question} className="flex flex-col gap-1.5">
          {q.header && (
            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {q.header}
            </span>
          )}
          <span className="text-sm font-medium text-foreground">{q.question}</span>
          <span className="text-[11px] text-muted-foreground">
            {q.multiSelect ? '选择一项或多项' : '选择一项'}
          </span>
          <div className="flex flex-col gap-1">
            {q.options.map((opt) => {
              const picked = q.multiSelect
                ? multi[q.question]?.has(opt.label)
                : single[q.question] === opt.label
              return (
                <label
                  key={opt.label}
                  className="flex cursor-pointer items-start gap-2 rounded border border-transparent p-2 hover:bg-accent"
                >
                  <input
                    type={q.multiSelect ? 'checkbox' : 'radio'}
                    name={q.question}
                    checked={picked ?? false}
                    onChange={(e) =>
                      q.multiSelect
                        ? toggleMulti(q.question, opt.label, e.target.checked)
                        : onRadio(q.question, opt.label)
                    }
                    className="mt-0.5 size-3.5"
                  />
                  <span className="flex flex-col">
                    <span className="text-[13px] font-medium text-foreground">{opt.label}</span>
                    {opt.description && (
                      <span className="text-[11px] text-muted-foreground">{opt.description}</span>
                    )}
                  </span>
                </label>
              )
            })}
            {/* Other 选项 */}
            <label className="flex cursor-pointer items-start gap-2 rounded border border-transparent p-2 hover:bg-accent">
              <input
                type={q.multiSelect ? 'checkbox' : 'radio'}
                name={q.question}
                checked={
                  q.multiSelect
                    ? multi[q.question]?.has(OTHER_VALUE)
                    : single[q.question] === OTHER_VALUE
                }
                onChange={(e) =>
                  q.multiSelect
                    ? toggleMulti(q.question, OTHER_VALUE, e.target.checked)
                    : onRadio(q.question, OTHER_VALUE)
                }
                className="mt-0.5 size-3.5"
              />
              <div className="flex flex-1 flex-col gap-1">
                <span className="text-[13px] font-medium text-muted-foreground">Other</span>
                {(q.multiSelect
                  ? multi[q.question]?.has(OTHER_VALUE)
                  : single[q.question] === OTHER_VALUE) && (
                  <Input
                    placeholder="Type something..."
                    value={otherText[q.question] ?? ''}
                    onChange={(e: ChangeEvent<HTMLInputElement>) =>
                      setOtherText((p) => ({ ...p, [q.question]: e.target.value }))
                    }
                    className="text-[13px]"
                  />
                )}
              </div>
            </label>
          </div>
          <Input
            placeholder="Add notes (optional)"
            value={notes[q.question] ?? ''}
            onChange={(e: ChangeEvent<HTMLInputElement>) =>
              setNotes((p) => ({ ...p, [q.question]: e.target.value }))
            }
            className="text-[13px]"
          />
        </div>
      ))}

      <div className="flex justify-end gap-2">
        <Button size="sm" variant="outline" onClick={dismiss}>
          取消
        </Button>
        <Button size="sm" onClick={() => submit(buildAnswers())} disabled={!allAnswered}>
          提交
        </Button>
      </div>
    </div>
  )
}
