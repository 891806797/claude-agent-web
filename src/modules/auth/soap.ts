import { env } from '@/env'

/**
 * OA 登录 Web Service 客户端（SOAP RPC/literal）-- 自 claude-agent-desktop 移植。
 *
 * 对接众阳运营平台登录接口，对齐 Java 端 LoginUserService.userLoginHandler 的调用：
 *   - 操作:  login(arg0=账号, arg1=密码) -> return(JSON 字符串，含 status/msg)
 *   - 成功:  status === "success"
 *
 * 手写 SOAP envelope + fetch，不引入 soap 库（RPC/literal 结构固定，避免依赖坑）。
 * 不抛异常 -- 网络/格式错误统一转为 { success:false, message }，由调用方决定错误码。
 */

const TIMEOUT_MS = 10_000

/** 把 WSDL 地址（带 ?wsdl）转为 SOAP POST endpoint；已是 endpoint 则原样返回 */
function toEndpoint(wsdlOrEndpoint: string): string {
  return wsdlOrEndpoint.replace(/[?&]wsdl$/, '')
}

/** XML 特殊字符转义（账号/密码可能含 & < > 等） */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** 从 SOAP 响应提取 <return>...</return> 内的 JSON 并解析 */
function extractReturnJson(xml: string): Record<string, unknown> | null {
  const match = xml.match(/<return>([\s\S]*?)<\/return>/)
  if (!match) return null
  try {
    return JSON.parse(match[1]!)
  } catch {
    return null
  }
}

export interface SoapLoginResult {
  success: boolean
  message: string
}

/** 调 OA Web Service 校验账号密码；不抛异常，失败以 { success:false, message } 返回 */
export async function soapVerifyLogin(
  username: string,
  password: string,
): Promise<SoapLoginResult> {
  const endpoint = toEndpoint(env.AUTH_WEB_SERVICE_URL)
  const envelope =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">' +
    '<soap:Body>' +
    `<tns:login xmlns:tns="${env.AUTH_WEB_SERVICE_NS}">` +
    `<arg0>${escapeXml(username)}</arg0>` +
    `<arg1>${escapeXml(password)}</arg1>` +
    '</tns:login>' +
    '</soap:Body>' +
    '</soap:Envelope>'

  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: '""' },
      body: envelope,
      signal: ctrl.signal,
    })
    clearTimeout(timer)

    if (!res.ok) {
      return { success: false, message: `登录服务 HTTP ${res.status}` }
    }

    const json = extractReturnJson(await res.text())
    if (!json) {
      return { success: false, message: '登录服务返回格式异常' }
    }

    const success = json.status === 'success'
    const message = typeof json.msg === 'string' ? json.msg : success ? '登录成功' : '登录失败'
    return { success, message }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { success: false, message: `登录服务调用失败：${msg}` }
  }
}
