import { useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { Bot } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { CaptchaPuzzle } from '@/components/CaptchaPuzzle'
import { useAuthStore } from '@/stores/auth'
import { api, ApiError } from '@/lib/api'

type Step = 'credentials' | 'bind' | 'verify' | 'reset'

/** 后端错误消息兜底（非 ApiError 时给通用提示） */
function errMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message
  return '服务调用失败，请稍后重试'
}

/**
 * 登录页（/login 路由）：强制 MFA 流程（对齐 desktop 四步状态机）。
 * 1. credentials：账号密码 + 拼图验证 -> POST /api/auth/login（OA SOAP 验密 + 限流，不签发 token）
 * 2. 按是否已绑定 MFA 分流：
 *    - 未绑定(bind)：显示二维码扫码绑定，输入动态码确认 -> /mfa/confirm 签发 cookie
 *    - 已绑定(verify)：输入动态码 -> /mfa/verify 签发 cookie
 * MFA 通过才签发 JWT cookie，杜绝跳过二次认证。
 * 已登录访问本页自动跳首页。
 */
export function LoginPage(): React.JSX.Element {
  const navigate = useNavigate()
  const username = useAuthStore((s) => s.username)
  const setLoggedIn = useAuthStore((s) => s.setLoggedIn)
  const [step, setStep] = useState<Step>('credentials')

  // credentials 步骤
  const [loginName, setLoginName] = useState('')
  const [password, setPassword] = useState('')
  const [showCaptcha, setShowCaptcha] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // MFA 步骤共用
  const [account, setAccount] = useState('')
  const [mfaCode, setMfaCode] = useState('')
  const [qrDataUrl, setQrDataUrl] = useState('')
  // reset 步骤：手机丢失恢复入口（重输密码确认身份后解绑重绑）
  const [resetPassword, setResetPassword] = useState('')

  // 已登录 -> 跳首页
  if (username) return <Navigate to="/" replace />

  /** MFA 通过（服务端已签发 cookie）后收尾 */
  const finishLogin = (me: { username: string }): void => {
    setLoggedIn(me.username)
    navigate('/', { replace: true })
  }

  /** credentials：拼图通过 -> login -> 按 MFA 绑定态走 bind/verify */
  const handleLogin = async (): Promise<void> => {
    if (loading) return
    setError('')
    setLoading(true)
    try {
      await api.post<{ needMfa: true }>('/api/auth/login', {
        username: loginName,
        password
      })
      // SOAP 验密通过 -> 强制 MFA 二次认证，按绑定态分流
      setAccount(loginName)
      setMfaCode('')
      const { bound } = await api.get<{ bound: boolean }>(
        `/api/auth/mfa/status?username=${encodeURIComponent(loginName)}`
      )
      if (bound) {
        setStep('verify')
      } else {
        await refreshQrCode(loginName)
        setStep('bind')
      }
    } catch (err) {
      setError(errMessage(err))
    } finally {
      setLoading(false)
    }
  }

  /** bind：刷新二维码（重新 mfa/setup 生成新 secret，需再验一次密码） */
  const refreshQrCode = async (acc: string): Promise<void> => {
    setError('')
    try {
      const res = await api.post<{ otpauthUrl: string; qrDataUrl: string }>('/api/auth/mfa/setup', {
        username: acc,
        password
      })
      setQrDataUrl(res.qrDataUrl)
    } catch (err) {
      setError(errMessage(err))
    }
  }

  /** bind：确认绑定（验证一个动态码 -> 持久化 secret + 签发 cookie） */
  const handleConfirmBind = async (): Promise<void> => {
    if (loading || mfaCode.length !== 6) return
    setError('')
    setLoading(true)
    try {
      finishLogin(
        await api.post<{ username: string }>('/api/auth/mfa/confirm', {
          username: account,
          token: mfaCode
        })
      )
    } catch (err) {
      setError(errMessage(err))
    } finally {
      setLoading(false)
    }
  }

  /** verify：验证动态码 -> 签发 cookie */
  const handleMfaVerify = async (): Promise<void> => {
    if (loading || mfaCode.length !== 6) return
    setError('')
    setLoading(true)
    try {
      finishLogin(
        await api.post<{ username: string }>('/api/auth/mfa/verify', {
          username: account,
          token: mfaCode
        })
      )
    } catch (err) {
      setError(errMessage(err))
    } finally {
      setLoading(false)
    }
  }

  /** reset：重新输密码确认身份 -> 解绑旧 MFA -> 走绑定流程（手机丢失恢复入口） */
  const handleReset = async (): Promise<void> => {
    if (loading || !resetPassword) return
    setError('')
    setLoading(true)
    try {
      // 重新调 login 验证密码（OA SOAP），作为重置 MFA 的身份门槛
      await api.post('/api/auth/login', { username: account, password: resetPassword })
      // 密码正确 -> 解绑旧 MFA（无可用动态码，靠密码重验兜底）-> 生成新二维码走绑定流程
      await api.post('/api/auth/mfa/unbind', { username: account, password: resetPassword })
      setMfaCode('')
      setResetPassword('')
      setPassword(resetPassword)
      await refreshQrCode(account)
      setStep('bind')
    } catch (err) {
      setError(errMessage(err))
    } finally {
      setLoading(false)
    }
  }

  /** 拼图验证回调：通过则收起拼图并触发登录；失败由 CaptchaPuzzle 内部回弹重试 */
  const handleCaptchaVerify = (success: boolean): void => {
    if (!success) return
    setShowCaptcha(false)
    void handleLogin()
  }

  /** 返回账号密码步骤（MFA 步骤用） */
  const backToCredentials = (): void => {
    setStep('credentials')
    setMfaCode('')
    setQrDataUrl('')
    setResetPassword('')
    setError('')
  }

  /** MFA 验证码输入：仅 6 位数字 */
  const onMfaCodeChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    setMfaCode(e.target.value.replace(/\D/g, '').slice(0, 6))
  }

  const onKeyDownMfa = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter' && mfaCode.length === 6 && !loading) {
      void (step === 'bind' ? handleConfirmBind() : handleMfaVerify())
    }
  }

  const canSubmit = !!loginName && !!password && !loading

  const onKeyDownCreds = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter' && canSubmit) setShowCaptcha(true)
  }

  return (
    <div className="flex h-screen bg-background">
      {/* 左侧品牌展示区（宽窗口显示） */}
      <div
        className="relative hidden w-1/2 flex-col items-center justify-center overflow-hidden md:flex"
        style={{ background: 'linear-gradient(135deg, #1c1612 0%, #33271f 45%, #241a14 100%)' }}
      >
        {/* 琥珀光晕（右上） */}
        <div
          className="pointer-events-none absolute -right-40 -top-40 size-[28rem] rounded-full"
          style={{ background: 'radial-gradient(circle, rgba(200,160,106,0.26), transparent 70%)' }}
        />
        {/* 暖棕光晕（左下） */}
        <div
          className="pointer-events-none absolute -bottom-40 -left-40 size-[28rem] rounded-full"
          style={{ background: 'radial-gradient(circle, rgba(180,120,70,0.18), transparent 70%)' }}
        />
        <div className="relative flex flex-col items-center gap-7 px-8">
          <div className="flex size-24 items-center justify-center rounded-2xl border border-[rgba(200,160,106,0.25)] bg-white/[0.03] shadow-2xl backdrop-blur">
            <Bot className="size-14 text-[#c8a06a]" />
          </div>
          <div className="flex flex-col items-center gap-3">
            <span className="text-[28px] font-semibold tracking-wide text-[#f5efe6]">
              AI 编码智能体
            </span>
            <span className="text-[13px] font-light tracking-[0.3em] text-[rgba(220,200,170,0.6)]">
              智能编码 · Web 版
            </span>
          </div>
        </div>
        <div className="absolute bottom-8 left-0 right-0 text-center text-[12px] tracking-wide text-white/35">
          © 2026 AI 编码智能体
        </div>
      </div>

      {/* 右侧表单区 */}
      <div className="flex flex-1 items-center justify-center overflow-y-auto p-6">
        <div className="flex w-[400px] max-w-full flex-col gap-6">
          {/* 窄窗口品牌头（宽窗口隐藏，品牌在左屏） */}
          <div className="flex flex-col items-center gap-2 pb-2 md:hidden">
            <Bot className="size-12 text-primary" />
            <span className="text-[16px] font-semibold tracking-wide text-foreground">
              AI 编码智能体
            </span>
          </div>

          {step === 'credentials' && (
            <>
              <div className="flex flex-col items-center gap-1.5 pb-1">
                <h1 className="text-[22px] font-semibold text-foreground">登录</h1>
                <p className="text-[12px] text-muted-foreground">使用账号密码登录以继续</p>
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="username">用户名</Label>
                <Input
                  id="username"
                  value={loginName}
                  onChange={(e) => setLoginName(e.target.value)}
                  placeholder="请输入用户名"
                  onKeyDown={onKeyDownCreds}
                  autoFocus
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="password">密码</Label>
                <Input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="请输入密码"
                  onKeyDown={onKeyDownCreds}
                />
              </div>
              {error && <p className="-mt-2 text-[12px] text-destructive">{error}</p>}
              {showCaptcha ? (
                <div className="flex flex-col items-center gap-2 rounded-lg border bg-card p-4">
                  <CaptchaPuzzle onVerify={handleCaptchaVerify} />
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={loading}
                    onClick={() => setShowCaptcha(false)}
                  >
                    {loading ? '登录中…' : '收起验证'}
                  </Button>
                </div>
              ) : (
                <Button
                  className="bg-primary text-primary-foreground enabled:hover:bg-primary/90"
                  disabled={!canSubmit}
                  onClick={() => setShowCaptcha(true)}
                >
                  {loading ? '登录中…' : '登录'}
                </Button>
              )}
            </>
          )}

          {step === 'bind' && (
            <>
              <div className="flex flex-col items-center gap-1.5 pb-1">
                <h1 className="text-center text-[22px] font-semibold text-foreground">绑定 MFA</h1>
                <p className="text-center text-[12px] text-muted-foreground">
                  使用 Google/Microsoft Authenticator 等扫码绑定
                </p>
              </div>
              {qrDataUrl ? (
                <div className="flex justify-center">
                  <img src={qrDataUrl} alt="MFA 二维码" className="size-48" />
                </div>
              ) : (
                <div className="mx-auto size-48 animate-pulse rounded-md bg-muted" />
              )}
              <div className="flex flex-col gap-2">
                <Label htmlFor="mfa-code">动态验证码</Label>
                <Input
                  id="mfa-code"
                  value={mfaCode}
                  onChange={onMfaCodeChange}
                  onKeyDown={onKeyDownMfa}
                  placeholder="6 位动态码"
                  inputMode="numeric"
                  autoFocus
                />
              </div>
              {error && <p className="-mt-2 text-[12px] text-destructive">{error}</p>}
              <Button
                className="bg-primary text-primary-foreground enabled:hover:bg-primary/90"
                disabled={loading || mfaCode.length !== 6}
                onClick={() => void handleConfirmBind()}
              >
                {loading ? '验证中…' : '确认绑定'}
              </Button>
              <div className="flex justify-between">
                <Button variant="ghost" size="sm" onClick={backToCredentials}>
                  返回
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void refreshQrCode(account)}
                  disabled={loading}
                >
                  刷新二维码
                </Button>
              </div>
            </>
          )}

          {step === 'verify' && (
            <>
              <div className="flex flex-col items-center gap-1.5 pb-1">
                <h1 className="text-center text-[22px] font-semibold text-foreground">
                  动态码验证
                </h1>
                <p className="text-center text-[12px] break-all text-muted-foreground">
                  账号 {account}，请输入认证器上的 6 位动态码
                </p>
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="mfa-code">动态验证码</Label>
                <Input
                  id="mfa-code"
                  value={mfaCode}
                  onChange={onMfaCodeChange}
                  onKeyDown={onKeyDownMfa}
                  placeholder="6 位动态码"
                  inputMode="numeric"
                  autoFocus
                />
              </div>
              {error && <p className="-mt-2 text-[12px] text-destructive">{error}</p>}
              <Button
                className="bg-primary text-primary-foreground enabled:hover:bg-primary/90"
                disabled={loading || mfaCode.length !== 6}
                onClick={() => void handleMfaVerify()}
              >
                {loading ? '验证中…' : '验证'}
              </Button>
              <Button variant="ghost" size="sm" onClick={backToCredentials}>
                返回
              </Button>
              <button
                type="button"
                className="mt-1 text-[12px] text-muted-foreground hover:text-foreground"
                onClick={() => {
                  setResetPassword('')
                  setError('')
                  setStep('reset')
                }}
              >
                手机丢失？重置 MFA
              </button>
            </>
          )}

          {step === 'reset' && (
            <>
              <div className="flex flex-col items-center gap-1.5 pb-1">
                <h1 className="text-center text-[22px] font-semibold text-foreground">重置 MFA</h1>
                <p className="text-center text-[12px] text-muted-foreground">
                  重新输入登录密码以解绑旧 MFA 并绑定新设备
                </p>
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="reset-password">登录密码</Label>
                <Input
                  id="reset-password"
                  type="password"
                  value={resetPassword}
                  onChange={(e) => setResetPassword(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && resetPassword && !loading) void handleReset()
                  }}
                  placeholder="登录密码"
                  autoFocus
                />
              </div>
              {error && <p className="-mt-2 text-[12px] text-destructive">{error}</p>}
              <Button
                className="bg-primary text-primary-foreground enabled:hover:bg-primary/90"
                disabled={loading || !resetPassword}
                onClick={() => void handleReset()}
              >
                {loading ? '重置中…' : '确认重置'}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setResetPassword('')
                  setError('')
                  setStep('verify')
                }}
              >
                返回
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
