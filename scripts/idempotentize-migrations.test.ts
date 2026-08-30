import { describe, expect, test } from 'bun:test'
import { idempotentizeSql, idempotentizeStatement } from './idempotentize-migrations'

describe('idempotentizeStatement', () => {
  test('CREATE TABLE 补 IF NOT EXISTS（内联约束不受影响）', () => {
    const sql =
      'CREATE TABLE "users" (\n\t"id" uuid PRIMARY KEY NOT NULL,\n\tCONSTRAINT "users_username_unique" UNIQUE("username")\n);'
    expect(idempotentizeStatement(sql)).toBe(
      'CREATE TABLE IF NOT EXISTS "users" (\n\t"id" uuid PRIMARY KEY NOT NULL,\n\tCONSTRAINT "users_username_unique" UNIQUE("username")\n);',
    )
  })

  test('CREATE INDEX / CREATE UNIQUE INDEX 补 IF NOT EXISTS', () => {
    expect(idempotentizeStatement('CREATE INDEX "idx" ON "t" USING btree ("c");')).toBe(
      'CREATE INDEX IF NOT EXISTS "idx" ON "t" USING btree ("c");',
    )
    expect(idempotentizeStatement('CREATE UNIQUE INDEX "uq" ON "t" ("c");')).toBe(
      'CREATE UNIQUE INDEX IF NOT EXISTS "uq" ON "t" ("c");',
    )
  })

  test('CREATE TYPE 包 DO 块（PG 无 IF NOT EXISTS 语法）', () => {
    const out = idempotentizeStatement(
      `CREATE TYPE "public"."article_status" AS ENUM('draft', 'published');`,
    )
    expect(out).toContain('DO $$')
    expect(out).toContain(`CREATE TYPE "public"."article_status" AS ENUM('draft', 'published');`)
    expect(out).toContain('EXCEPTION WHEN duplicate_object THEN NULL;')
  })

  test('DROP TABLE/TYPE/INDEX 补 IF EXISTS', () => {
    expect(idempotentizeStatement('DROP TABLE "articles" CASCADE;')).toBe(
      'DROP TABLE IF EXISTS "articles" CASCADE;',
    )
    expect(idempotentizeStatement('DROP TYPE "public"."article_status";')).toBe(
      'DROP TYPE IF EXISTS "public"."article_status";',
    )
  })

  test('ADD COLUMN / 裸 ADD 补 IF NOT EXISTS（不误伤 ADD CONSTRAINT）', () => {
    expect(idempotentizeStatement('ALTER TABLE "users" ADD COLUMN "role" text;')).toBe(
      'ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "role" text;',
    )
    expect(idempotentizeStatement('ALTER TABLE "users" ADD "role" text;')).toBe(
      'ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "role" text;',
    )
    const fk = idempotentizeStatement(
      'ALTER TABLE "t" ADD CONSTRAINT "t_a_b_fk" FOREIGN KEY ("a") REFERENCES "b" ("id");',
    )
    expect(fk).toContain('DO $$')
    expect(fk).not.toContain('ADD COLUMN')
  })

  test('DROP COLUMN / DROP CONSTRAINT 补 IF EXISTS', () => {
    expect(idempotentizeStatement('ALTER TABLE "t" DROP COLUMN "c";')).toBe(
      'ALTER TABLE "t" DROP COLUMN IF EXISTS "c";',
    )
    expect(idempotentizeStatement('ALTER TABLE "t" DROP "c";')).toBe(
      'ALTER TABLE "t" DROP COLUMN IF EXISTS "c";',
    )
    expect(idempotentizeStatement('ALTER TABLE "t" DROP CONSTRAINT "t_c_unique";')).toBe(
      'ALTER TABLE "t" DROP CONSTRAINT IF EXISTS "t_c_unique";',
    )
  })

  test('天然幂等的语句不动（ALTER COLUMN 系列）', () => {
    const sql = 'ALTER TABLE "t" ALTER COLUMN "c" SET NOT NULL;'
    expect(idempotentizeStatement(sql)).toBe(sql)
    const sql2 = 'ALTER TABLE "t" ALTER COLUMN "c" SET DATA TYPE text;'
    expect(idempotentizeStatement(sql2)).toBe(sql2)
  })

  test('已是 DO 块的语句原样返回', () => {
    const wrapped =
      'DO $$\nBEGIN\n  CREATE TYPE "t" AS ENUM(\'a\');\nEXCEPTION WHEN duplicate_object THEN NULL;\nEND $$;'
    expect(idempotentizeStatement(wrapped)).toBe(wrapped)
  })
})

describe('idempotentizeSql', () => {
  test('按 breakpoint 切分重组，末尾换行', () => {
    const file =
      'CREATE TABLE "a" ("id" int);\n--> statement-breakpoint\nCREATE INDEX "i" ON "a" ("id");\n'
    expect(idempotentizeSql(file)).toBe(
      'CREATE TABLE IF NOT EXISTS "a" ("id" int);\n--> statement-breakpoint\nCREATE INDEX IF NOT EXISTS "i" ON "a" ("id");\n',
    )
  })

  test('同分隔符写法也正确重组', () => {
    const file = `CREATE TYPE "public"."s" AS ENUM('a');--> statement-breakpoint\nCREATE TABLE "t" ("c" "s");`
    const out = idempotentizeSql(file)
    expect(out.split('--> statement-breakpoint')).toHaveLength(2)
    expect(out).toContain('DO $$')
    expect(out).toContain('CREATE TABLE IF NOT EXISTS')
    expect(out.endsWith('\n')).toBe(true)
  })

  test('幂等：重复运行输出不变', () => {
    const file = `CREATE TYPE "public"."s" AS ENUM('a');--> statement-breakpoint
CREATE TABLE "t" ("id" int);
--> statement-breakpoint
CREATE INDEX "i" ON "t" ("id");--> statement-breakpoint
ALTER TABLE "t" ADD COLUMN "c" text;--> statement-breakpoint
ALTER TABLE "t" ADD CONSTRAINT "t_c_fk" FOREIGN KEY ("c") REFERENCES "t2" ("id");--> statement-breakpoint
DROP TABLE "old" CASCADE;--> statement-breakpoint
DROP TYPE "public"."s2";`
    expect(idempotentizeSql(idempotentizeSql(file))).toBe(idempotentizeSql(file))
  })

  test('空文件原样返回', () => {
    expect(idempotentizeSql('')).toBe('')
    expect(idempotentizeSql('\n')).toBe('\n')
  })
})
