import { bigint, boolean, index, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { appSchema } from '@/db/app-schema'

/**
 * auth 表定义 -- 只依赖 drizzle-orm，不依赖任何业务代码（drizzle-kit 独立加载）。
 * 列名由全局 casing: 'snake_case' 自动生成，禁止手写列名字符串。
 */

/**
 * users：登录用户档案。密码不落库（SOAP 在线验密），此表只承载 MFA 绑定与审计信息。
 * mfa_secret_enc：AES-256-GCM 密文（iv:tag:ciphertext base64 拼接），密钥见 env AUTH_MFA_ENC_KEY。
 */
export const users = appSchema.table('users', {
  id: uuid().primaryKey().defaultRandom(),
  username: text().notNull().unique(),
  /** 角色：admin / user；admin 由 AUTH_ADMIN_USERS 白名单在登录时自动提升（本期仅存储与下发） */
  role: text().$type<UserRole>().notNull().default('user'),
  mfaSecretEnc: text(),
  mfaBoundAt: timestamp({ withTimezone: true }),
  /** TOTP 防重放：最近一次验证通过的时间片 counter，<= 它的码拒绝复用 */
  totpLastCounter: bigint({ mode: 'number' }),
  lastLoginAt: timestamp({ withTimezone: true }),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
})

/**
 * login_attempts：登录尝试流水，支撑限流（窗口内失败 N 次临时锁定）。
 * 保留窗口外的记录仅供审计，由服务层定期清理。
 */
export const loginAttempts = appSchema.table(
  'login_attempts',
  {
    id: uuid().primaryKey().defaultRandom(),
    username: text().notNull(),
    ip: text().notNull(),
    success: boolean().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('login_attempts_username_created_idx').on(t.username, t.createdAt)],
)

export type UserRow = typeof users.$inferSelect
export type LoginAttemptRow = typeof loginAttempts.$inferSelect
/** 用户角色值域（users.role） */
export type UserRole = 'admin' | 'user'
