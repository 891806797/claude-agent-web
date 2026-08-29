import { z } from '@hono/zod-openapi'

/**
 * auth 模块的 zod DTO -- 请求校验、TS 类型、OpenAPI 文档的唯一真源。
 * 注意：z 一律从 '@hono/zod-openapi' 导入（带 .openapi() 扩展），禁止从 'zod' 导入。
 */

export const LoginInput = z.object({
  username: z.string().min(1).max(64).openapi({ example: 'zhangsan' }),
  password: z.string().min(1).max(128).openapi({ example: 'p@ssw0rd' }),
})

/** 密码验证通过但尚未做 MFA（强制 MFA，登录成功恒需二次验证） */
export const LoginResultDto = z
  .object({
    needMfa: z.literal(true),
  })
  .openapi('LoginResult')

export const MfaStatusDto = z
  .object({
    bound: z.boolean().openapi({ example: false }),
  })
  .openapi('MfaStatus')

export const MfaSetupResultDto = z
  .object({
    otpauthUrl: z.string().openapi({ example: 'otpauth://totp/...' }),
    /** 二维码图片 data URL，前端 <img src> 直接显示 */
    qrDataUrl: z.string().openapi({ example: 'data:image/png;base64,...' }),
  })
  .openapi('MfaSetupResult')

export const MfaTokenInput = z.object({
  username: z.string().min(1).max(64).openapi({ example: 'zhangsan' }),
  token: z
    .string()
    .regex(/^\d{6}$/)
    .openapi({ example: '123456' }),
})

/** setup 需先验密（防任意人为他人账号生成绑定二维码）；confirm 只需动态码（setup 已验密） */
export const MfaSetupInput = LoginInput

export const MfaUnbindInput = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(128),
  /** 动态码可选：管理页解绑时校验；登录页「手机丢失重置」无可用动态码，靠密码重验兜底（对齐 desktop） */
  token: z
    .string()
    .regex(/^\d{6}$/)
    .optional(),
})

export const MeDto = z
  .object({
    username: z.string().openapi({ example: 'zhangsan' }),
    role: z.enum(['admin', 'user']).openapi({ example: 'user' }),
  })
  .openapi('Me')

export type LoginData = z.infer<typeof LoginInput>
export type MfaTokenData = z.infer<typeof MfaTokenInput>
export type MfaUnbindData = z.infer<typeof MfaUnbindInput>
