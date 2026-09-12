import { z } from '@hono/zod-openapi'

/**
 * system 模块 zod DTO —— deep-link 拉起 / 版本 / 自更新请求校验与响应真源。
 * z 一律从 '@hono/zod-openapi' 导入。
 */

/** 当前平台归一化 key（与 build-exe.ts 命名一致：windows-x64 / linux-x64 / darwin-arm64） */
export const PlatformKey = z
  .enum(['windows-x64', 'linux-x64', 'darwin-arm64', 'darwin-x64', 'linux-arm64'])
  .openapi('SystemPlatform')

export const PlatformAssetDto = z.object({
  url: z.string().url(),
  sha256: z.string(),
  size: z.number().int().optional(),
})

export const LatestManifestDto = z.object({
  version: z.string(),
  releaseDate: z.string().optional(),
  platforms: z.record(PlatformKey, PlatformAssetDto),
})

/** 版本检测响应 */
export const VersionResultDto = z
  .object({
    current: z.string(),
    latest: z.string().nullable(),
    updateAvailable: z.boolean(),
    releaseDate: z.string().nullable().optional(),
  })
  .openapi('SystemVersion')

export type VersionResult = z.infer<typeof VersionResultDto>

/** deep-link / 内部 launch 入参（热转发或测试用，body 传协议链接） */
export const LaunchInput = z.object({
  url: z
    .string()
    .min(1)
    .openapi({ example: 'csm-coding-agent-web://download?url=...&name=demo&user=zhangsan' }),
})

export const DownloadUpdateResultDto = z
  .object({
    ok: z.literal(true),
    path: z.string(),
    version: z.string(),
  })
  .openapi('SystemUpdateDownload')

export type LatestManifest = z.infer<typeof LatestManifestDto>
export type PlatformAsset = z.infer<typeof PlatformAssetDto>
export type PlatformKey = z.infer<typeof PlatformKey>
