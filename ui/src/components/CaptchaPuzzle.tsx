import { useCallback, useEffect, useRef, useState } from 'react'

interface CaptchaPuzzleProps {
  /** 验证回调：通过 true / 失败 false（失败由组件内部回弹重试） */
  onVerify: (success: boolean) => void
}

const BG_W = 256
const BG_H = 140
const PIECE_SIZE = 44
const SLIDER_W = 36
const TRACK_W = BG_W - SLIDER_W // 滑块可移动范围（= 拼图块可达最右）
const TOLERANCE = 16 // 对准容差（px）

/**
 * 拼图滑块验证（纯前端 canvas，无后端校验，对齐 desktop 实现；防爆破由服务端限流兜底）。
 * canvas 生成随机背景 + 从背景抠出拼图块 + 缺口标记；拖滑块移动拼图块，松手比对缺口位置。
 * 通过 -> onVerify(true)；失败 -> 回弹 + onVerify(false)，可继续重试。
 */
export function CaptchaPuzzle({ onVerify }: CaptchaPuzzleProps): React.JSX.Element {
  const [bgImg, setBgImg] = useState('')
  const [pieceImg, setPieceImg] = useState('')
  const [targetX, setTargetX] = useState(0)
  const [targetY, setTargetY] = useState(0)
  const [sliderX, setSliderX] = useState(0)
  const [status, setStatus] = useState<'idle' | 'success' | 'fail'>('idle')
  const [dragging, setDragging] = useState(false)
  const onVerifyRef = useRef(onVerify)
  onVerifyRef.current = onVerify
  const startXRef = useRef(0)
  const sliderXRef = useRef(0)
  const targetXRef = useRef(0)

  const generate = useCallback(() => {
    // 背景 canvas：随机渐变 + 几何图案
    const canvas = document.createElement('canvas')
    canvas.width = BG_W
    canvas.height = BG_H
    const ctx = canvas.getContext('2d')!
    const hue1 = Math.random() * 360
    const hue2 = (hue1 + 80) % 360
    const grad = ctx.createLinearGradient(0, 0, BG_W, BG_H)
    grad.addColorStop(0, `hsl(${hue1}, 60%, 50%)`)
    grad.addColorStop(1, `hsl(${hue2}, 65%, 55%)`)
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, BG_W, BG_H)
    for (let i = 0; i < 12; i++) {
      ctx.strokeStyle = `hsla(${Math.random() * 360}, 60%, 70%, 0.15)`
      ctx.lineWidth = 3
      ctx.beginPath()
      ctx.moveTo(Math.random() * BG_W, 0)
      ctx.lineTo(Math.random() * BG_W, BG_H)
      ctx.stroke()
    }
    for (let i = 0; i < 6; i++) {
      ctx.fillStyle = `hsla(${Math.random() * 360}, 70%, 60%, 0.2)`
      ctx.beginPath()
      ctx.arc(Math.random() * BG_W, Math.random() * BG_H, Math.random() * 28 + 10, 0, Math.PI * 2)
      ctx.fill()
    }

    // 缺口位置（拼图块 Y 与缺口一致）
    const tx = Math.random() * (BG_W - PIECE_SIZE - 50) + 50
    const ty = Math.random() * (BG_H - PIECE_SIZE - 10) + 5
    setTargetX(tx)
    setTargetY(ty)
    targetXRef.current = tx

    // 拼图块 canvas：从背景 (tx,ty) 抠出，加描边
    const pCanvas = document.createElement('canvas')
    pCanvas.width = PIECE_SIZE
    pCanvas.height = PIECE_SIZE
    const pCtx = pCanvas.getContext('2d')!
    pCtx.drawImage(canvas, tx, ty, PIECE_SIZE, PIECE_SIZE, 0, 0, PIECE_SIZE, PIECE_SIZE)
    pCtx.strokeStyle = 'rgba(255,255,255,0.85)'
    pCtx.lineWidth = 2
    pCtx.strokeRect(1, 1, PIECE_SIZE - 2, PIECE_SIZE - 2)
    setBgImg(canvas.toDataURL())
    setPieceImg(pCanvas.toDataURL())

    setSliderX(0)
    sliderXRef.current = 0
    setStatus('idle')
  }, [])

  useEffect(() => {
    generate()
  }, [generate])

  const onMouseDown = (e: React.MouseEvent): void => {
    if (status === 'success') return
    startXRef.current = e.clientX
    setDragging(true)
  }

  useEffect(() => {
    if (!dragging) return
    const onMove = (e: MouseEvent): void => {
      const delta = e.clientX - startXRef.current
      const next = Math.max(0, Math.min(TRACK_W, delta))
      sliderXRef.current = next
      setSliderX(next)
    }
    const onUp = (): void => {
      setDragging(false)
      const ok = Math.abs(sliderXRef.current - targetXRef.current) < TOLERANCE
      setStatus(ok ? 'success' : 'fail')
      onVerifyRef.current(ok)
      if (!ok) {
        // 失败：短暂展示后回弹，允许重试
        setTimeout(() => {
          setSliderX(0)
          sliderXRef.current = 0
          setStatus('idle')
        }, 600)
      }
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [dragging])

  return (
    <div className="flex w-full select-none flex-col gap-3" style={{ width: BG_W }}>
      {/* 拼图区 */}
      <div className="relative overflow-hidden rounded-md" style={{ width: BG_W, height: BG_H }}>
        {bgImg && <img src={bgImg} alt="" className="block h-full w-full" draggable={false} />}
        {/* 缺口标记 */}
        <div
          className="absolute rounded-sm"
          style={{
            left: targetX,
            top: targetY,
            width: PIECE_SIZE,
            height: PIECE_SIZE,
            boxShadow: 'inset 0 0 0 2px rgba(255,255,255,0.6)',
            background: 'rgba(0,0,0,0.28)'
          }}
        />
        {/* 拼图块 */}
        {pieceImg && (
          <img
            src={pieceImg}
            alt=""
            className="pointer-events-none absolute"
            style={{ left: sliderX, top: targetY, width: PIECE_SIZE, height: PIECE_SIZE }}
            draggable={false}
          />
        )}
      </div>
      {/* 滑块条 */}
      <div className="relative h-9 overflow-hidden rounded-md bg-muted">
        <div
          className={[
            'absolute inset-y-0 left-0 transition-colors',
            status === 'success'
              ? 'bg-emerald-500'
              : status === 'fail'
                ? 'bg-red-500'
                : 'bg-blue-500'
          ].join(' ')}
          style={{ width: sliderX }}
        />
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[12px]">
          {status === 'success' ? (
            <span className="text-white">✓ 验证通过</span>
          ) : status === 'fail' ? (
            <span className="text-white">验证失败，重试</span>
          ) : (
            <span className="text-muted-foreground">拖动滑块对准缺口</span>
          )}
        </div>
        <div
          className="absolute top-0 flex h-full cursor-grab items-center justify-center rounded-md bg-white shadow-sm active:cursor-grabbing"
          style={{ width: SLIDER_W, left: sliderX }}
          onMouseDown={onMouseDown}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke={status === 'success' ? '#10b981' : '#999'}
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </div>
      </div>
    </div>
  )
}
