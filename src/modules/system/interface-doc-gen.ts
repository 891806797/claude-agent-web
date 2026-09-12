import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getLogger } from '@/core/logger'

/**
 * 内部接口文档生成 —— 自 .claude/skills/interface-documents/scripts/generate-doc.js 移植为 ESM。
 *
 * 单 exe 部署机无全局 skill 路径、无 node 子进程，必须自包含。
 * HTTP 改用 Bun 原生 fetch（替 node:https 手写 wrapper），逻辑与原脚本逐函数对齐：
 *   交互类 → getCatalogWithDetails(appId) → walkCatalogForDetails + formatApiDetail
 *   埋点类 → getServicesByUrls(urls)      → formatMaiDianApiDetail
 * 接口平台 portal/service 两端点均免鉴权。
 *
 * 详见 gitopts/interface-documents skill 与 OpenCodeBizV2Service 原始实现。
 */

const logger = getLogger('system-doc-gen')

// ─── 通用工具（对齐原脚本 str/sanitizeDesc/prettyJson）──────────────────────────

/** 取字符串值：null/undefined/空白串 → def，其余 trim */
function str(v: unknown, def = ''): string {
  if (v == null) return def
  const s = typeof v === 'string' ? v : String(v)
  const t = s.trim()
  return t.length ? t : def
}

const CODE_PATTERN = /^(\d+\.\d+(\.\d+)?(\.\d+)?)/
/** 接口编号提取：优先开头「数字.数字[.数字[.数字]]」，否则名称前 20 字符小写下划线 */
function extractCode(name: unknown): string {
  const s = str(name)
  if (!s) return ''
  const m = CODE_PATTERN.exec(s)
  if (m?.[1]) return m[1]
  return s.replace(/ /g, '_').toLowerCase().slice(0, 20)
}

/** 描述清洗：去换行、转义表格管道符、截断 */
function sanitizeDesc(desc: unknown, maxLen: number): string {
  const s = str(desc)
  if (!s) return '-'
  return s.replace(/\n/g, ' ').replace(/\|/g, '\\|').slice(0, maxLen)
}

function prettyJson(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2)
  } catch {
    return s
  }
}

// ─── 最小结构类型（portal 返回的 catalog 树形状，仅声明被访问字段）──────────────

interface Param {
  name?: unknown
  type?: unknown
  desc?: unknown
  required?: unknown
  objectProps?: Param[] | unknown
}
interface ParamsObj {
  objectProps?: Param[] | unknown
}
interface ApiDetail {
  interfaceName?: unknown
  url?: unknown
  interfaceType?: unknown
  description?: unknown
  interfaceInputExample?: unknown
  interfaceOutputExample?: unknown
  reqQuery?: ParamsObj | unknown
  reqBody?: ParamsObj | unknown
  resBody?: ParamsObj | unknown
}
interface CatalogNode {
  key?: unknown
  apiDetail?: ApiDetail | unknown
  children?: CatalogNode[] | unknown
}
interface MaiDianApi {
  interfaceName?: unknown
  productName?: unknown
  url?: unknown
  description?: unknown
  remark?: unknown
  interfaceInputExample?: unknown
  reqBody?: ParamsObj | unknown
  resBody?: ParamsObj | unknown
}

function asParams(v: unknown): Param[] | undefined {
  return Array.isArray(v) ? (v as Param[]) : undefined
}

// ─── 参数表格（递归嵌套，对齐 formatParams/appendParamsSection）─────────────────

function formatParams(
  props: Param[] | undefined,
  prefix: string,
  maxDepth: number,
  currentDepth: number,
  withRequired: boolean,
): string {
  if (!props || currentDepth >= maxDepth) return ''
  let out = ''
  for (const p of props) {
    if (!p) continue
    const name = str(p.name, '-')
    const ptype = str(p.type, '-')
    const desc = sanitizeDesc(p.desc, withRequired ? 80 : 60)
    const displayName = !prefix ? name : prefix + name
    if (withRequired) {
      out += `| ${displayName} | ${ptype} | ${p.required === true ? '是' : '否'} | ${desc} |\n`
    } else {
      out += `| ${displayName} | ${ptype} | ${desc} |\n`
    }
    const sub = asParams(p.objectProps)
    if (sub && sub.length > 0 && currentDepth < maxDepth - 1) {
      const s = formatParams(sub, `${prefix}└─ `, maxDepth, currentDepth + 1, withRequired)
      if (s) out += s
    }
  }
  return out
}

function appendParamsSection(paramsObj: unknown, title: string, withRequired: boolean): string {
  const obj = paramsObj as ParamsObj | undefined
  const props = asParams(obj?.objectProps)
  if (!props) return ''
  let out = `#### ${title}\n`
  out += withRequired
    ? '| 参数名 | 类型 | 必填 | 说明 |\n|--------|------|------|------|\n'
    : '| 参数名 | 类型 | 说明 |\n|--------|------|------|\n'
  out += formatParams(props, '', 5, 0, withRequired)
  out += '\n'
  return out
}

/** 响应 data 字段类型修正：输出示例 data 为数组时，resBody 声明 object 改 array */
function fixResponseTypeMismatch(
  resBody: ParamsObj | undefined,
  outputExample: string,
): ParamsObj | undefined {
  if (!resBody) return resBody
  const props = asParams(resBody.objectProps)
  if (!props) return resBody
  try {
    const actual = JSON.parse(outputExample) as { data?: unknown }
    if (Array.isArray(actual.data)) {
      for (const prop of props) {
        if (prop && prop.name === 'data' && prop.type === 'object') prop.type = 'array'
      }
    }
  } catch {
    // 输出示例非合法 JSON，跳过
  }
  return resBody
}

// ─── 交互类详情（对齐 formatApiDetail / walkCatalogForDetails）─────────────────

function formatApiDetail(api: ApiDetail): string {
  const name = str(api.interfaceName)
  const code = extractCode(name)
  const url = str(api.url)
  const method = str(api.interfaceType, '-')
  const desc = str(api.description).replace(/\n/g, ' ').replace(/\|/g, '\\|')
  const inputExample = str(api.interfaceInputExample)
  const outputExample = str(api.interfaceOutputExample)

  let sb = ''
  sb += `<a id="${code}"></a>\n`
  sb += `### ${name}\n\n`
  sb += `**接口路径**: \`${url}\`\n`
  sb += `**请求方法**: \`${method}\`\n`
  sb += `**接口描述**: ${desc}\n\n`
  sb += appendParamsSection(api.reqQuery, '请求参数', true)
  sb += appendParamsSection(api.reqBody, '请求体参数', true)
  let resBody = (api.resBody as ParamsObj | undefined) ?? undefined
  if (resBody && outputExample) resBody = fixResponseTypeMismatch(resBody, outputExample)
  sb += appendParamsSection(resBody, '响应参数', false)
  if (inputExample) sb += `#### 请求示例\n\`\`\`\n${inputExample.slice(0, 500)}\n\`\`\`\n\n`
  if (outputExample) {
    sb += '#### 响应示例\n```json\n'
    try {
      sb += `${JSON.stringify(JSON.parse(outputExample), null, 2).slice(0, 1500)}\n`
    } catch {
      sb += `${outputExample.slice(0, 1500)}\n`
    }
    sb += '```\n\n'
  }
  sb += '---\n\n'
  return sb
}

interface ApiListItem {
  id: string
  code: string
  name: string
  url: string
  method: string
}

function walkCatalogForDetails(
  nodes: CatalogNode[] | undefined,
  apiList: ApiListItem[],
  apiDetails: string[],
): void {
  if (!nodes) return
  for (const node of nodes) {
    if (!node) continue
    const key = node.key
    if (typeof key === 'string' && key.startsWith('api-')) {
      const apiId = key.slice(4)
      const detail = node.apiDetail as ApiDetail | undefined
      if (detail) {
        const name = str(detail.interfaceName)
        apiList.push({
          id: apiId,
          code: extractCode(name),
          name,
          url: str(detail.url),
          method: str(detail.interfaceType, '-'),
        })
        apiDetails.push(formatApiDetail(detail))
      }
    }
    const children = asNodes(node.children)
    if (children && children.length > 0) walkCatalogForDetails(children, apiList, apiDetails)
  }
}

function asNodes(v: unknown): CatalogNode[] | undefined {
  return Array.isArray(v) ? (v as CatalogNode[]) : undefined
}

// ─── HTTP（fetch 替 node:https，超时经 AbortController）─────────────────────────

interface PortalResponse<T> {
  success?: unknown
  message?: unknown
  data?: T
}

async function fetchJson(url: string, init: RequestInit, timeoutMs = 60000): Promise<unknown> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${text.slice(0, 500)}`)
    }
    return JSON.parse(text) as unknown
  } finally {
    clearTimeout(timer)
  }
}

// ─── 交互类文档（getCatalogWithDetails）────────────────────────────────────────

/** 拉取交互类接口目录并渲染 markdown；失败/空返回空串（非致命） */
export async function generateHisApiDoc(baseUrl: string, appId: string): Promise<string> {
  const url = `${baseUrl}/portal/service/getCatalogWithDetails?appId=${encodeURIComponent(appId)}`
  logger.info({ appId }, '拉取交互类接口目录')
  const response = (await fetchJson(url, { method: 'GET' })) as PortalResponse<CatalogNode[]>
  if (response.success !== true) {
    logger.warn({ appId, message: response.message }, 'getCatalogWithDetails 返回失败')
    return ''
  }
  const catalog = asNodes(response.data)
  if (!catalog || catalog.length === 0) {
    logger.warn({ appId }, 'appId 无接口数据')
    return ''
  }
  const apiList: ApiListItem[] = []
  const apiDetails: string[] = []
  walkCatalogForDetails(catalog, apiList, apiDetails)
  logger.info({ appId, count: apiList.length }, '交互类接口拉取完成')

  let sb = ''
  sb += '# 内部接口文档\n\n'
  sb += `appId: ${appId}\n\n`
  sb += '---\n\n'
  sb += '## 一、接口目录\n\n'
  sb += '| 接口编号 | 接口名称 | 接口ID | 接口URL | 接口Method | 详情链接 |\n'
  sb += '|---------|---------|--------|---------|-----------|---------|\n'
  for (const item of apiList) {
    sb += `| ${item.code} | ${item.name} | ${item.id} | ${item.url} | ${item.method} | [查看详情](#${item.code}) |\n`
  }
  sb += '\n---\n\n'
  sb += '## 二、接口详情\n\n'
  for (const detail of apiDetails) sb += detail
  return sb
}

// ─── 埋点类详情（getServicesByUrls）─────────────────────────────────────────────

function formatMaiDianApiDetail(api: MaiDianApi): string {
  let sb = ''
  const interfaceName = str(api.interfaceName)
  sb += `# ${interfaceName}\n\n`
  sb += `## 产品名称\n${str(api.productName)}\n\n`
  sb += `## 接口名称\n${interfaceName}\n\n`
  sb += `## MethodName（url）\n${str(api.url)}\n\n`
  const description = str(api.description)
  if (description) sb += `## 接口描述\n${description.replace(/\n/g, ' ').replace(/\|/g, '\\|')}\n\n`
  const remark = str(api.remark)
  if (remark) sb += `## Remark\n${remark.replace(/\n/g, ' ').replace(/\|/g, '\\|')}\n\n`
  const inputExample = str(api.interfaceInputExample)
  sb += '## 入参示例\n```\n'
  sb += inputExample || '// 入参示例 TODO'
  sb += '\n```\n\n'
  const reqBody = api.reqBody as ParamsObj | undefined
  sb += '## 入参字段描述\n'
  if (reqBody && asParams(reqBody.objectProps)) {
    sb += '| 参数名 | 类型 | 必填 | 说明 |\n|--------|------|------|------|\n'
    sb += formatParams(asParams(reqBody.objectProps), '', 5, 0, true)
  } else {
    sb += '// 入参字段描述，表格形式 TODO\n'
  }
  sb += '\n'
  const resBody = api.resBody as ParamsObj | undefined
  sb += '## 出参字段描述\n'
  if (resBody && asParams(resBody.objectProps)) {
    sb += '| 参数名 | 类型 | 说明 |\n|--------|------|------|\n'
    sb += formatParams(asParams(resBody.objectProps), '', 5, 0, false)
  } else {
    sb += '// 出参字段描述，表格形式 TODO\n'
  }
  sb += '\n'
  return sb
}

/** 拉取埋点类接口并渲染 markdown */
export async function generateMaiDianApiDoc(baseUrl: string, urls: string[]): Promise<string> {
  const url = `${baseUrl}/portal/service/getServicesByUrls`
  logger.info({ count: urls.length }, '拉取埋点类接口')
  const response = (await fetchJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(urls),
  })) as PortalResponse<MaiDianApi[]>
  if (response.success !== true) {
    logger.warn({ message: response.message }, 'getServicesByUrls 返回失败')
    return ''
  }
  const catalog = Array.isArray(response.data) ? (response.data as MaiDianApi[]) : undefined
  if (!catalog || catalog.length === 0) {
    logger.warn('埋点类无接口数据')
    return ''
  }
  let sb = ''
  for (let i = 0; i < catalog.length; i++) {
    sb += formatMaiDianApiDetail(catalog[i]!)
    if (i < catalog.length - 1) sb += '\n---\n\n'
  }
  return sb
}

// ─── 编排（读 git-info.json，分类拉取，拼接）──────────────────────────────────

interface GitInfo {
  interfaceInfos?: Array<{
    interfaceType?: unknown
    appId?: unknown
    maiDianUrls?: unknown[] | unknown
  }>
}

/**
 * 生成内部接口文档全文并写盘到 {dir}/内部接口文档.md。
 * 埋点段在前、交互段在后，段间「\n\n---\n\n」分隔。
 * git-info.json 缺失/解析失败/无 interfaceInfos → 抛错（调用方决定是否降级）。
 */
export async function generateInternalDoc(workspaceDir: string, baseUrl: string): Promise<void> {
  const gitInfoPath = join(workspaceDir, 'git-info.json')
  let gitInfo: GitInfo
  try {
    gitInfo = (await Bun.file(gitInfoPath).json()) as GitInfo
  } catch {
    throw new Error(`git-info.json 不存在或解析失败: ${gitInfoPath}`)
  }
  const interfaceInfos = Array.isArray(gitInfo.interfaceInfos) ? gitInfo.interfaceInfos : []
  if (interfaceInfos.length === 0) {
    throw new Error('git-info.json 的 interfaceInfos 为空')
  }

  // 埋点类：合并所有 maiDianUrls（distinct）
  const maiDianUrls: string[] = []
  let hasMaiDianEntry = false
  for (const info of interfaceInfos) {
    if (!info || str(info.interfaceType) !== '埋点类') continue
    hasMaiDianEntry = true
    if (Array.isArray(info.maiDianUrls)) {
      for (const u of info.maiDianUrls) {
        const t = str(u)
        if (t && !maiDianUrls.includes(t)) maiDianUrls.push(t)
      }
    }
  }

  let doc = ''
  if (maiDianUrls.length > 0) {
    const maiDianDoc = await generateMaiDianApiDoc(baseUrl, maiDianUrls)
    if (maiDianDoc) doc += maiDianDoc
  } else if (hasMaiDianEntry) {
    logger.warn('存在埋点类条目但 maiDianUrls 为空，跳过埋点类文档')
  }

  // 交互类：对每个 appId（distinct）分别拉取
  const interactAppIds: string[] = []
  for (const info of interfaceInfos) {
    if (!info || str(info.interfaceType) !== '交互类') continue
    const appId = str(info.appId)
    if (appId && !interactAppIds.includes(appId)) interactAppIds.push(appId)
  }
  for (const appId of interactAppIds) {
    const hisDoc = await generateHisApiDoc(baseUrl, appId)
    if (!hisDoc) continue
    if (doc) doc += '\n\n---\n\n'
    doc += hisDoc
  }

  if (doc.trim()) {
    await writeFile(join(workspaceDir, '内部接口文档.md'), doc, 'utf-8')
    logger.info({ workspaceDir }, '内部接口文档已生成')
  } else {
    logger.warn(
      { workspaceDir },
      '未生成任何接口文档内容（interfaceInfos 无有效 appId/maiDianUrls，或接口平台返回空）',
    )
  }
}

export { prettyJson }
