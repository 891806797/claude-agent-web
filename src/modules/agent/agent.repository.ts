import { count, desc, eq, gte, sum } from 'drizzle-orm'
import type { DbExecutor } from '@/db'
import { type AgentProjectRow, agentProjects, agentSessionStats } from './agent.table'

/**
 * agent 数据访问层 —— 只关心 SQL，不做业务判断、不抛业务错误，返回原始 Row。
 * 约定：首参一律 executor: DbExecutor。
 * （agent_session_stats 的写入在 session-registry 关闭流程里 fire-and-forget，也走本层。）
 */
export const agentRepository = {
  async listProjects(executor: DbExecutor): Promise<AgentProjectRow[]> {
    return executor.select().from(agentProjects).orderBy(desc(agentProjects.createdAt))
  },

  async findProjectByPath(
    executor: DbExecutor,
    path: string,
  ): Promise<AgentProjectRow | undefined> {
    const [row] = await executor
      .select()
      .from(agentProjects)
      .where(eq(agentProjects.path, path))
      .limit(1)
    return row
  },

  async findProjectById(executor: DbExecutor, id: string): Promise<AgentProjectRow | undefined> {
    const [row] = await executor
      .select()
      .from(agentProjects)
      .where(eq(agentProjects.id, id))
      .limit(1)
    return row
  },

  async createProject(
    executor: DbExecutor,
    data: { name: string; path: string; createdBy: string },
  ): Promise<AgentProjectRow> {
    const [row] = await executor.insert(agentProjects).values(data).returning()
    // insert returning 必返回插入的行
    return row!
  },

  async removeProject(executor: DbExecutor, id: string): Promise<boolean> {
    const removed = await executor
      .delete(agentProjects)
      .where(eq(agentProjects.id, id))
      .returning({ id: agentProjects.id })
    return removed.length > 0
  },

  /** 会话用量归档（关闭流程 fire-and-forget 调用，失败仅记日志） */
  async insertSessionStats(
    executor: DbExecutor,
    data: {
      sessionId: string
      workspaceDir: string
      username: string
      startedAt: Date
      closedAt: Date
      lifeCycleMs: number
      lastActiveAt: Date
      turns: number
      inputTokens: number
      outputTokens: number
      closeReason: string
    },
  ): Promise<void> {
    await executor.insert(agentSessionStats).values(data)
  },

  /** 看板：历史会话统计聚合（总量/今日/token 累计/按关闭原因分布） */
  async sessionStatsAggregate(
    executor: DbExecutor,
    todayStart: Date,
  ): Promise<{
    totalSessions: number
    todaySessions: number
    totalInputTokens: number
    totalOutputTokens: number
    byCloseReason: Record<string, number>
  }> {
    const [totals] = await executor
      .select({
        totalSessions: count(),
        totalInputTokens: sum(agentSessionStats.inputTokens),
        totalOutputTokens: sum(agentSessionStats.outputTokens),
      })
      .from(agentSessionStats)
    const [today] = await executor
      .select({ todaySessions: count() })
      .from(agentSessionStats)
      .where(gte(agentSessionStats.closedAt, todayStart))
    const reasonRows = await executor
      .select({ closeReason: agentSessionStats.closeReason, n: count() })
      .from(agentSessionStats)
      .groupBy(agentSessionStats.closeReason)
    const byCloseReason: Record<string, number> = {}
    for (const r of reasonRows) byCloseReason[r.closeReason] = r.n
    return {
      totalSessions: totals?.totalSessions ?? 0,
      todaySessions: today?.todaySessions ?? 0,
      totalInputTokens: Number(totals?.totalInputTokens ?? 0),
      totalOutputTokens: Number(totals?.totalOutputTokens ?? 0),
      byCloseReason,
    }
  },

  /** 看板：项目总数 */
  async countProjects(executor: DbExecutor): Promise<number> {
    const [row] = await executor.select({ count: count() }).from(agentProjects)
    return row?.count ?? 0
  },
}
