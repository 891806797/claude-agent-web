import { bigint, index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

/**
 * agent 模块表：
 * - agent_projects：项目目录白名单（openSession 只接受已注册 path，web 安全边界）
 * - agent_session_stats：会话用量归档（run 粒度；同 sessionId 多次 resume 多行）
 * - agent_personas：自定义智能体定义（append 到 claude_code 预设后的系统提示词）
 * - agent_session_personas：会话-智能体绑定快照（resume 重开时回填注入，保证人格不漂移）
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

export const agentPersonas = pgTable('agent_personas', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  description: text('description').notNull().default(''),
  /** 追加到 claude_code 预设后的系统提示词（原文注入，不自动包装） */
  systemPrompt: text('system_prompt').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const agentSessionPersonas = pgTable('agent_session_personas', {
  /** SDK 会话 id（resume 回填的键；一个会话至多一条绑定） */
  sessionId: text('session_id').primaryKey(),
  /** 溯源用（无外键；persona 删除后悬空无害，注入以快照为准） */
  personaId: uuid('persona_id').notNull(),
  /** persona 名快照（persona 事后改名/删除不影响历史会话展示与注入） */
  personaName: text('persona_name').notNull(),
  /** 提示词快照（resume 重开进程时注入的即此值，防人格漂移） */
  systemPrompt: text('system_prompt').notNull(),
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
export type AgentPersonaRow = typeof agentPersonas.$inferSelect
export type AgentSessionPersonaRow = typeof agentSessionPersonas.$inferSelect
