import { describe, expect, test } from 'bun:test'
import { AppError } from '@/core/app-error'
import { parseDeepLink } from './launch.service'
import { compareVersion } from './system.service'

/**
 * deep-link 解析器与版本比对单测 —— 守护 bootstrap 输入边界（路径穿越/缺 user/非法 action）。
 * 不触 DB/网络，纯函数。launch.service 的其他分支（下载/解压/开浏览器）走集成手测。
 */

describe('parseDeepLink', () => {
  test('解析合法 download 链接', () => {
    const r = parseDeepLink(
      'csm-coding-agent-web://download?url=https://a/a.zip&name=demo&user=zhangsan',
    )
    expect(r.action).toBe('download')
    expect(r.zipUrl).toBe('https://a/a.zip')
    expect(r.name).toBe('demo')
    expect(r.user).toBe('zhangsan')
  })

  test('agent 可选', () => {
    const r = parseDeepLink('csm-coding-agent-web://download?url=x&name=demo&user=u&agent=reviewer')
    expect(r.agent).toBe('reviewer')
  })

  test('缺 user 抛 SYSTEM_DEEPLINK_NO_USER', () => {
    expect(() => parseDeepLink('csm-coding-agent-web://download?url=x&name=demo')).toThrow(AppError)
  })

  test('缺 url/name 抛错', () => {
    expect(() => parseDeepLink('csm-coding-agent-web://download?user=u')).toThrow(AppError)
  })

  test('name 路径穿越（..）抛错', () => {
    expect(() => parseDeepLink('csm-coding-agent-web://download?url=x&name=..&user=u')).toThrow(
      AppError,
    )
  })

  test('name 含分隔符抛错', () => {
    expect(() => parseDeepLink('csm-coding-agent-web://download?url=x&name=a/b&user=u')).toThrow(
      AppError,
    )
  })

  test('非 download action 抛错', () => {
    expect(() => parseDeepLink('csm-coding-agent-web://open?user=u')).toThrow(AppError)
  })

  test('协议格式错误抛错', () => {
    expect(() => parseDeepLink('not-a-url')).toThrow(AppError)
  })
})

describe('compareVersion', () => {
  test('高位大者胜', () => {
    expect(compareVersion('0.2.0', '0.1.0')).toBeGreaterThan(0)
    expect(compareVersion('0.1.0', '0.2.0')).toBeLessThan(0)
    expect(compareVersion('1.0.0', '1.0.0')).toBe(0)
  })

  test('不同段数补 0 比', () => {
    expect(compareVersion('1.2', '1.2.1')).toBeLessThan(0)
    expect(compareVersion('1.2.1', '1.2')).toBeGreaterThan(0)
  })

  test('数字段按数值比（10 > 9）', () => {
    expect(compareVersion('1.10.0', '1.9.0')).toBeGreaterThan(0)
  })
})
