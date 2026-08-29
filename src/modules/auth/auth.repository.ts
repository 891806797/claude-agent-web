import { and, desc, eq, gte, sql } from 'drizzle-orm'
import type { DbExecutor } from '@/db'
import { loginAttempts, type UserRow, users } from './auth.table'

/**
 * auth 数据访问层 -- 只关心 SQL，不做业务判断、不抛业务错误，返回原始 Row。
 * 约定：首参一律 executor: DbExecutor（db 或事务 tx 皆可传入）。
 */

export const authRepository = {
  async findByUsername(executor: DbExecutor, username: string): Promise<UserRow | undefined> {
    const [row] = await executor.select().from(users).where(eq(users.username, username)).limit(1)
    return row
  },

  /** 首次登录建档（密码不落库，只有用户名档案位） */
  async ensureUser(executor: DbExecutor, username: string): Promise<UserRow> {
    const [row] = await executor
      .insert(users)
      .values({ username })
      .onConflictDoNothing({ target: users.username })
      .returning()
    if (row) return row
    const existing = await authRepository.findByUsername(executor, username)
    return existing!
  },

  /** 用户列表（管理用；不含密码/secret，仅档案与 MFA 状态） */
  async listUsers(
    executor: DbExecutor,
  ): Promise<Array<Pick<UserRow, 'username' | 'mfaBoundAt' | 'lastLoginAt' | 'createdAt'>>> {
    return executor
      .select({
        username: users.username,
        mfaBoundAt: users.mfaBoundAt,
        lastLoginAt: users.lastLoginAt,
        createdAt: users.createdAt,
      })
      .from(users)
      .orderBy(desc(users.lastLoginAt))
  },

  /** 总用户数（看板统计用） */
  async countUsers(executor: DbExecutor): Promise<number> {
    const [row] = await executor.select({ count: sql<number>`count(*)::int` }).from(users)
    return row?.count ?? 0
  },

  async updateMfaBinding(
    executor: DbExecutor,
    username: string,
    data: { mfaSecretEnc: string; mfaBoundAt: Date },
  ): Promise<void> {
    await executor.update(users).set(data).where(eq(users.username, username))
  },

  async unbindMfa(executor: DbExecutor, username: string): Promise<void> {
    await executor
      .update(users)
      .set({ mfaSecretEnc: null, mfaBoundAt: null, totpLastCounter: null })
      .where(eq(users.username, username))
  },

  async updateTotpCounter(executor: DbExecutor, username: string, counter: number): Promise<void> {
    await executor
      .update(users)
      .set({ totpLastCounter: counter })
      .where(eq(users.username, username))
  },

  async touchLastLogin(executor: DbExecutor, username: string): Promise<void> {
    await executor
      .update(users)
      .set({ lastLoginAt: new Date() })
      .where(eq(users.username, username))
  },

  /** 白名单提升：置为 admin（幂等；仅 user -> admin 单向，本期无降级路径） */
  async promoteToAdmin(executor: DbExecutor, username: string): Promise<void> {
    await executor.update(users).set({ role: 'admin' }).where(eq(users.username, username))
  },

  async recordAttempt(
    executor: DbExecutor,
    data: { username: string; ip: string; success: boolean },
  ): Promise<void> {
    await executor.insert(loginAttempts).values(data)
  },

  /** 窗口内（自 since 起）该 用户名+IP 组合的失败次数 */
  async countFailuresSince(
    executor: DbExecutor,
    username: string,
    ip: string,
    since: Date,
  ): Promise<number> {
    const [row] = await executor
      .select({ count: sql<number>`count(*)::int` })
      .from(loginAttempts)
      .where(
        and(
          eq(loginAttempts.username, username),
          eq(loginAttempts.ip, ip),
          eq(loginAttempts.success, false),
          gte(loginAttempts.createdAt, since),
        ),
      )
    return row?.count ?? 0
  },

  /** 清理保留窗口外的流水（仅审计价值）；retainBefore 之前的删除 */
  async cleanupAttempts(executor: DbExecutor, retainBefore: Date): Promise<void> {
    await executor.delete(loginAttempts).where(sql`${loginAttempts.createdAt} < ${retainBefore}`)
  },
}
