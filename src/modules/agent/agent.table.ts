import { bigint, index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

/**
 * agent 模块表：
 * - agent_projects：项目目录白名单（openSession 只接受已注册 path，web 安全边界）
 * - agent_session_stats：会话用量归档（run 粒度；同 sessionId 多次 resume 多行）
 * 会话消息本体存 SDK JSONL（按用户隔离的 CLAUDE_CONFIG_DIR），不入库。
 */

export const agentProjects = pgTable('agent_projects', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  /** 项目绝对路径（注册时已归一化为正斜杠小写，唯一） */
  path: text('path').notNull().unique(),
  createdBy: text('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const agentSessionStats = pgTable(
  'agent_session_stats',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: text('session_id').notNull(),
    workspaceDir: text('workspace_dir').notNull(),
    username: text('username').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    closedAt: timestamp('closed_at', { withTimezone: true }).notNull(),
    lifeCycleMs: bigint('life_cycle_ms', { mode: 'number' }).notNull(),
    lastActiveAt: timestamp('last_active_at', { withTimezone: true }).notNull(),
    turns: integer('turns').notNull().default(0),
    inputTokens: bigint('input_tokens', { mode: 'number' }).notNull().default(0),
    outputTokens: bigint('output_tokens', { mode: 'number' }).notNull().default(0),
    /** user_close | idle_gc | logout | evict | life_limit | shutdown | error | process_exit */
    closeReason: text('close_reason').notNull(),
  },
  (t) => [index('agent_session_stats_username_idx').on(t.username)],
)

export type AgentProjectRow = typeof agentProjects.$inferSelect
export type AgentSessionStatsRow = typeof agentSessionStats.$inferSelect
