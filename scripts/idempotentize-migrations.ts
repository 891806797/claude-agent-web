import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 迁移 SQL 幂等化（db:generate 的固定后置步骤，也支持单独重跑）。
 *
 * 背景：drizzle-kit 生成的 DDL 不带 IF [NOT] EXISTS，重放（记录表丢失/手工执行/
 * 部分应用的库）会报 already exists。本脚本把 src/db/migrations/*.sql 改写为
 * 可重复执行的形式：
 * - CREATE TABLE / INDEX、DROP TABLE / INDEX / TYPE、ADD|DROP COLUMN、DROP CONSTRAINT
 *   → PG 原生 IF [NOT] EXISTS
 * - CREATE TYPE、ALTER TYPE ADD VALUE、ALTER TABLE ADD CONSTRAINT（PG 无对应
 *   IF NOT EXISTS 语法）→ DO 块捕获 duplicate_object 静默跳过
 * - ALTER COLUMN SET/DROP NOT NULL、SET DATA TYPE、SET DEFAULT 重放天然不报错，不动
 *
 * 约束：幂等（重复运行输出不变）；不触碰 meta/（drizzle-kit diff 依据）。
 * drizzle 迁移器按 journal 时间戳判定已应用（不比对文件内容），改写不影响旧库。
 * 迁移文件禁止手改——本脚本是唯一合法的批量改写入径。
 */

const MIGRATIONS_DIR = 'src/db/migrations'
const BREAKPOINT = '--> statement-breakpoint'

/** 行内替换规则（负向前瞻防止对已幂等形式二次套用） */
const INLINE_RULES: Array<[RegExp, string]> = [
  [/^CREATE TABLE (?!IF NOT EXISTS)/im, 'CREATE TABLE IF NOT EXISTS '],
  [/^CREATE UNIQUE INDEX (?!IF NOT EXISTS)/im, 'CREATE UNIQUE INDEX IF NOT EXISTS '],
  [/^CREATE INDEX (?!IF NOT EXISTS)/im, 'CREATE INDEX IF NOT EXISTS '],
  [/^DROP TABLE (?!IF EXISTS)/im, 'DROP TABLE IF EXISTS '],
  [/^DROP INDEX (?!IF EXISTS)/im, 'DROP INDEX IF EXISTS '],
  [/^DROP TYPE (?!IF EXISTS)/im, 'DROP TYPE IF EXISTS '],
  // (?=") 排除 ADD CONSTRAINT / DROP CONSTRAINT（后跟关键字而非引号列名）
  [/\bADD COLUMN (?!IF NOT EXISTS)(?=")/im, 'ADD COLUMN IF NOT EXISTS '],
  [/\bADD (?!COLUMN|CONSTRAINT|IF NOT EXISTS)(?=")/im, 'ADD COLUMN IF NOT EXISTS '],
  [/\bDROP COLUMN (?!IF EXISTS)(?=")/im, 'DROP COLUMN IF EXISTS '],
  [/\bDROP (?!COLUMN|CONSTRAINT|IF EXISTS)(?=")/im, 'DROP COLUMN IF EXISTS '],
  [/\bDROP CONSTRAINT (?!IF EXISTS)(?=")/im, 'DROP CONSTRAINT IF EXISTS '],
]

/** 需整体包裹 DO 块的语句（PG 无 IF NOT EXISTS 语法，靠 duplicate_object 静默） */
const WRAP_RULES: RegExp[] = [
  /^CREATE TYPE /i,
  /^ALTER TYPE .* ADD VALUE/i,
  /^ALTER TABLE .* ADD CONSTRAINT /i,
]

/** 单条语句 → 幂等形式；已幂等（DO 块/已带 IF）原样返回 */
export function idempotentizeStatement(raw: string): string {
  const stmt = raw.trim()
  if (!stmt || stmt.startsWith('DO $$')) return raw
  if (WRAP_RULES.some((r) => r.test(stmt))) {
    return `DO $$\nBEGIN\n  ${stmt}\nEXCEPTION WHEN duplicate_object THEN NULL;\nEND $$;`
  }
  let out = raw
  for (const [pattern, replacement] of INLINE_RULES) {
    out = out.replace(pattern, replacement)
  }
  return out
}

/** 整个迁移文件 → 幂等形式（按 statement-breakpoint 切分逐条处理，重组为统一格式） */
export function idempotentizeSql(sql: string): string {
  const statements = sql
    .split(BREAKPOINT)
    .map((s) => idempotentizeStatement(s).trim())
    .filter(Boolean)
  return statements.length === 0 ? sql : `${statements.join(`\n${BREAKPOINT}\n`)}\n`
}

if (import.meta.main) {
  // biome-ignore lint/suspicious/noConsole: 脚本输出面向终端用户，非应用日志
  const say = console.log
  const names = readdirSync(MIGRATIONS_DIR)
    .filter((n) => n.endsWith('.sql'))
    .sort()
  if (names.length === 0) {
    say(`未找到迁移文件（${MIGRATIONS_DIR}/*.sql）`)
    process.exit(1)
  }
  for (const name of names) {
    const path = join(MIGRATIONS_DIR, name)
    const before = readFileSync(path, 'utf8')
    const after = idempotentizeSql(before)
    if (after === before) {
      say(`已是幂等形式，跳过：${name}`)
    } else {
      writeFileSync(path, after)
      say(`已幂等化：${name}`)
    }
  }
}
