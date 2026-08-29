import { useState } from 'react'
import { cn } from '@/lib/utils'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import type { ApprovalRequest } from '@/lib/agent-types'
import type { OnApprove } from './ApprovalShell'

interface QOption {
  label: string
  description?: string
  preview?: string
}
interface Question {
  question: string
  header?: string
  options: QOption[]
  multiSelect?: boolean
}

/** "Other" 选项的内部哨兵值 — 提交时替换为用户实际输入文本 */
const OTHER_VALUE = '__other__'

/** dock 容器：与 ChatInput 同款 bg-layer-01 / border-base，header/content/footer 用细分隔。
 *  flex column + max-h：header/footer 固定（shrink-0），content 区独立滚动（flex-1 overflow）。 */
const DOCK =
  'mx-4 my-2 rounded-lg border border-[var(--border-base)] bg-[var(--bg-layer-01)] shadow-[var(--elevation-raised)] overflow-hidden flex flex-col max-h-[60vh]'
const DOCK_HEADER =
  'flex items-center justify-between gap-3 px-4 py-2.5 border-b border-[var(--border-muted)] shrink-0'
const DOCK_CONTENT = 'flex-1 min-h-0 overflow-y-auto px-4 py-3'
const DOCK_FOOTER =
  'flex items-center gap-2 px-4 py-2.5 border-t border-[var(--border-muted)] shrink-0'

/** 进度段圆点：当前/已答/未答 三态 */
function ProgressDot({
  active,
  answered,
  onClick,
  label
}: {
  active: boolean
  answered: boolean
  onClick: () => void
  label: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className={cn(
        'size-2.5 rounded-full transition-all',
        active
          ? 'bg-[var(--grey-100)] ring-2 ring-[var(--grey-100)]/30 ring-offset-2 ring-offset-[var(--bg-layer-01)] scale-110'
          : answered
            ? 'bg-[var(--grey-100)]'
            : 'bg-[var(--border-base)] hover:bg-[var(--grey-500)]'
      )}
    />
  )
}

// ─────────────────────────────────────────────
// 子组件: 单题内容（选项卡片）
// ─────────────────────────────────────────────
function QuestionPanel({
  question,
  singleSelected,
  multiSelected,
  otherSelected,
  otherTexts,
  notes,
  onRadioChange,
  onToggleMulti,
  onUpdateOtherText,
  onUpdateNotes
}: {
  question: Question
  singleSelected: string
  multiSelected: Set<string>
  otherSelected: boolean
  otherTexts: string
  notes: string
  onRadioChange: (value: string) => void
  onToggleMulti: (label: string, checked: boolean) => void
  onUpdateOtherText: (text: string) => void
  onUpdateNotes: (text: string) => void
}): React.JSX.Element {
  const isMulti = !!question.multiSelect
  // 选项卡片在 dock(bg-layer-01) 内：未选透明、选中 bg-layer-02 凸显
  const cardCls = (picked: boolean): string =>
    cn(
      'flex items-start gap-3 rounded-md p-2.5 cursor-pointer transition-colors border',
      picked
        ? 'bg-[var(--bg-layer-02)] border-[var(--border-strong)]'
        : 'bg-transparent border-[var(--border-muted)] hover:bg-[var(--overlay-hover)]'
    )

  // 选项列表是 JSX 元素而非 render 内定义的组件：组件函数每次渲染都是新类型，
  // 会让整棵子树（含 Other 输入框）逐键重挂——受控 value 与原生输入竞争、IME 被打断
  const optionsList = (
    <>
      {question.options.map((opt) => (
        <label
          key={opt.label}
          htmlFor={`${question.question}-${opt.label}`}
          className={cardCls(isMulti ? multiSelected.has(opt.label) : singleSelected === opt.label)}
        >
          {isMulti ? (
            <Checkbox
              id={`${question.question}-${opt.label}`}
              checked={multiSelected.has(opt.label)}
              onCheckedChange={(checked: boolean) => onToggleMulti(opt.label, checked)}
              className="mt-0.5"
            />
          ) : (
            <RadioGroupItem
              value={opt.label}
              id={`${question.question}-${opt.label}`}
              className="mt-0.5"
            />
          )}
          <div className="flex flex-col gap-0.5 min-w-0">
            <span className="text-[13px] font-medium text-[var(--text-base)]">{opt.label}</span>
            {opt.description && (
              <span className="text-[11px] text-[var(--text-faint)] leading-relaxed">
                {opt.description}
              </span>
            )}
          </div>
        </label>
      ))}
      {/* Other 选项 */}
      <label htmlFor={`${question.question}-other`} className={cardCls(otherSelected)}>
        {isMulti ? (
          <Checkbox
            id={`${question.question}-other`}
            checked={otherSelected}
            onCheckedChange={(checked: boolean) => onToggleMulti(OTHER_VALUE, checked)}
            className="mt-0.5"
          />
        ) : (
          <RadioGroupItem
            value={OTHER_VALUE}
            id={`${question.question}-other`}
            className="mt-0.5"
          />
        )}
        <span className="text-[13px] font-medium text-[var(--text-muted)]">Other</span>
      </label>
      {otherSelected && (
        <Input
          placeholder="Type something..."
          value={otherTexts}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => onUpdateOtherText(e.target.value)}
          className="text-[13px]"
          autoFocus
        />
      )}
    </>
  )

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        {question.header && (
          <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
            {question.header}
          </span>
        )}
        <span className="text-[14px] font-medium text-[var(--text-base)] leading-snug">
          {question.question}
        </span>
        <span className="text-[11px] text-[var(--text-faint)]">
          {isMulti ? '选择一项或多项' : '选择一项'}
        </span>
      </div>

      {isMulti ? (
        <div className="flex flex-col gap-1.5">{optionsList}</div>
      ) : (
        <RadioGroup
          value={singleSelected}
          onValueChange={(value: string) => onRadioChange(value)}
          className="flex flex-col gap-1.5"
        >
          {optionsList}
        </RadioGroup>
      )}

      <Input
        placeholder="Add notes (optional)"
        value={notes}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => onUpdateNotes(e.target.value)}
        className="text-[13px]"
      />
    </div>
  )
}

// ─────────────────────────────────────────────
// 子组件: 提交回顾页
// ─────────────────────────────────────────────
function SubmitView({
  questions,
  answers,
  allAnswered
}: {
  questions: Question[]
  answers: Record<string, string>
  allAnswered: boolean
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      <span className="text-[14px] font-medium text-[var(--text-base)]">回顾你的回答</span>
      {!allAnswered && (
        <div className="rounded-md p-2 bg-[var(--bg-layer-02)] border border-[var(--border-muted)]">
          <span className="text-[12px] text-[var(--text-muted)]">⚠ 你还没有回答所有问题</span>
        </div>
      )}
      {Object.keys(answers).length > 0 && (
        <div className="flex flex-col gap-1.5">
          {questions
            .filter((q) => answers[q.question])
            .map((q) => (
              <div
                key={q.question}
                className="flex flex-col gap-0.5 rounded-md p-2 bg-[var(--bg-layer-02)] border border-[var(--border-muted)]"
              >
                <span className="text-[12px] text-[var(--text-muted)]">{q.question}</span>
                <span className="text-[13px] font-medium text-[var(--text-base)]">
                  → {answers[q.question]}
                </span>
              </div>
            ))}
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────
// 主组件: AskUserQuestionApproval
// ─────────────────────────────────────────────
export function AskUserQuestionApproval({
  request,
  onApprove
}: {
  request: ApprovalRequest
  onApprove: OnApprove
}): React.JSX.Element {
  const questions = ((request.input as { questions?: Question[] }).questions ?? []) as Question[]

  // ── 状态
  const [currentTab, setCurrentTab] = useState('q-0')
  const [singleSelected, setSingleSelected] = useState<Record<string, string>>({})
  const [multiSelected, setMultiSelected] = useState<Record<string, Set<string>>>({})
  const [otherTexts, setOtherTexts] = useState<Record<string, string>>({})
  const [notes, setNotes] = useState<Record<string, string>>({})

  // ── 计算派生数据
  const isSingleQuestionAutoSubmit = questions.length === 1 && !questions[0]?.multiSelect
  const hideSubmitTab = questions.length === 1 && !questions[0]?.multiSelect

  // ── 构造最终 answers (用于 Tab 状态显示 + 提交)
  const displayAnswers: Record<string, string> = {}
  for (const q of questions) {
    if (q.multiSelect) {
      const selected = multiSelected[q.question]
      if (selected && selected.size > 0) {
        const filtered = Array.from(selected)
          .filter((v) => v !== OTHER_VALUE)
          .concat(
            selected.has(OTHER_VALUE) && otherTexts[q.question]?.trim()
              ? [otherTexts[q.question].trim()]
              : selected.has(OTHER_VALUE)
                ? [OTHER_VALUE]
                : []
          )
        displayAnswers[q.question] = filtered.join(', ')
      }
    } else {
      const selected = singleSelected[q.question]
      if (selected) {
        displayAnswers[q.question] =
          selected === OTHER_VALUE ? otherTexts[q.question]?.trim() || OTHER_VALUE : selected
      }
    }
  }

  // ── 所有问题是否已回答
  const allAnswered = questions.every((q) => {
    if (q.multiSelect) {
      const sel = multiSelected[q.question]
      return sel && sel.size > 0
    }
    const sel = singleSelected[q.question]
    if (sel === OTHER_VALUE && !otherTexts[q.question]?.trim()) return false
    return !!sel
  })

  // ── 提交
  const submit = (): void => {
    const annotations: Record<string, { notes?: string }> = {}
    for (const q of questions) {
      const noteText = notes[q.question]?.trim()
      if (noteText) annotations[q.question] = { notes: noteText }
    }
    onApprove(true, { ...request.input, answers: displayAnswers, annotations })
  }

  // ── 单选变化
  const handleRadioChange = (questionText: string, value: string): void => {
    setSingleSelected((prev) => ({ ...prev, [questionText]: value }))
    // 单题单选 + 非 Other → 自动提交
    if (isSingleQuestionAutoSubmit && value !== OTHER_VALUE) {
      const answers: Record<string, string> = { [questionText]: value }
      const annotations: Record<string, { notes?: string }> = {}
      const noteText = notes[questionText]?.trim()
      if (noteText) annotations[questionText] = { notes: noteText }
      onApprove(true, { ...request.input, answers, annotations })
    }
  }

  // ── 多选 toggle
  const handleToggleMulti = (questionText: string, label: string, checked: boolean): void => {
    setMultiSelected((prev) => {
      const cur = new Set(prev[questionText] ?? [])
      if (checked) cur.add(label)
      else cur.delete(label)
      return { ...prev, [questionText]: cur }
    })
  }

  const dismiss = (): void => onApprove(false, undefined, '用户拒绝回答')

  // ── 单题单选模式（无导航，直接显示选项；选了即提交，除非 Other）
  if (isSingleQuestionAutoSubmit) {
    const q = questions[0]
    const sel = singleSelected[q.question] ?? ''
    const otherSel = sel === OTHER_VALUE

    return (
      <div className={DOCK}>
        <div className={DOCK_CONTENT}>
          <QuestionPanel
            question={q}
            singleSelected={sel}
            multiSelected={new Set()}
            otherSelected={otherSel}
            otherTexts={otherTexts[q.question] ?? ''}
            notes={notes[q.question] ?? ''}
            onRadioChange={(value) => handleRadioChange(q.question, value)}
            onToggleMulti={() => {}}
            onUpdateOtherText={(text) => setOtherTexts((prev) => ({ ...prev, [q.question]: text }))}
            onUpdateNotes={(text) => setNotes((prev) => ({ ...prev, [q.question]: text }))}
          />
        </div>
        {otherSel && (
          <div className={DOCK_FOOTER}>
            <Button
              variant="outline"
              size="sm"
              className="border-[var(--border-base)] bg-[var(--bg-layer-02)] text-[var(--text-base)] hover:bg-[var(--overlay-hover)]"
              onClick={dismiss}
            >
              取消
            </Button>
            <div className="flex-1" />
            <Button
              size="sm"
              className="bg-[var(--grey-100)] text-white hover:bg-[var(--grey-50)]"
              onClick={submit}
              disabled={!allAnswered}
            >
              提交
            </Button>
          </div>
        )}
      </div>
    )
  }

  // ── 多题 / 单题多选模式：dock + 进度段导航
  const total = questions.length
  const currentQIdx = currentTab.startsWith('q-') ? Number(currentTab.slice(2)) : -1
  const currentQuestion = currentQIdx >= 0 ? questions[currentQIdx] : null

  const jump = (tab: string): void => setCurrentTab(tab)
  const next = (): void => {
    if (currentTab === 'submit') return
    if (currentQIdx >= total - 1) {
      if (!hideSubmitTab) setCurrentTab('submit')
      return
    }
    setCurrentTab(`q-${currentQIdx + 1}`)
  }
  const back = (): void => {
    if (currentTab === 'submit') {
      setCurrentTab(`q-${total - 1}`)
      return
    }
    if (currentQIdx > 0) setCurrentTab(`q-${currentQIdx - 1}`)
  }

  const isLastQ = currentQIdx >= total - 1

  return (
    <div className={DOCK}>
      {/* header：进度摘要 + 进度段 */}
      <div className={DOCK_HEADER}>
        <span className="text-[12px] font-medium text-[var(--text-muted)]">
          {currentTab === 'submit' ? '回顾回答' : `问题 ${Math.max(currentQIdx + 1, 1)} / ${total}`}
        </span>
        <div className="flex items-center gap-1.5">
          {questions.map((q, i) => (
            <ProgressDot
              key={`q-${i}`}
              active={currentTab === `q-${i}`}
              answered={!!displayAnswers[q.question]}
              onClick={() => jump(`q-${i}`)}
              label={`问题 ${i + 1}`}
            />
          ))}
          {!hideSubmitTab && (
            <ProgressDot
              active={currentTab === 'submit'}
              answered={allAnswered}
              onClick={() => jump('submit')}
              label="回顾提交"
            />
          )}
        </div>
      </div>

      {/* content */}
      <div className={DOCK_CONTENT}>
        {currentTab === 'submit' ? (
          <SubmitView questions={questions} answers={displayAnswers} allAnswered={allAnswered} />
        ) : (
          currentQuestion && (
            <QuestionPanel
              question={currentQuestion}
              singleSelected={singleSelected[currentQuestion.question] ?? ''}
              multiSelected={multiSelected[currentQuestion.question] ?? new Set()}
              otherSelected={
                currentQuestion.multiSelect
                  ? multiSelected[currentQuestion.question]?.has(OTHER_VALUE)
                  : singleSelected[currentQuestion.question] === OTHER_VALUE
              }
              otherTexts={otherTexts[currentQuestion.question] ?? ''}
              notes={notes[currentQuestion.question] ?? ''}
              onRadioChange={(value) => handleRadioChange(currentQuestion.question, value)}
              onToggleMulti={(label, checked) =>
                handleToggleMulti(currentQuestion.question, label, checked)
              }
              onUpdateOtherText={(text) =>
                setOtherTexts((prev) => ({ ...prev, [currentQuestion.question]: text }))
              }
              onUpdateNotes={(text) =>
                setNotes((prev) => ({ ...prev, [currentQuestion.question]: text }))
              }
            />
          )
        )}
      </div>

      {/* footer */}
      <div className={DOCK_FOOTER}>
        <Button
          variant="outline"
          size="sm"
          className="border-[var(--border-base)] bg-[var(--bg-layer-02)] text-[var(--text-base)] hover:bg-[var(--overlay-hover)]"
          onClick={dismiss}
        >
          取消
        </Button>
        <div className="flex-1" />
        {(currentQIdx > 0 || currentTab === 'submit') && (
          <Button variant="secondary" size="sm" onClick={back}>
            上一题
          </Button>
        )}
        {currentTab === 'submit' ? (
          <Button
            size="sm"
            className="bg-[var(--grey-100)] text-white hover:bg-[var(--grey-50)]"
            onClick={submit}
            disabled={!allAnswered}
          >
            提交
          </Button>
        ) : (
          <Button
            size="sm"
            className="bg-[var(--grey-100)] text-white hover:bg-[var(--grey-50)]"
            onClick={next}
          >
            {isLastQ ? '完成' : '下一题'}
          </Button>
        )}
      </div>
    </div>
  )
}
