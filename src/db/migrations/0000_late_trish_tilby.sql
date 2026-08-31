CREATE SCHEMA IF NOT EXISTS "claude_agent_web";
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "claude_agent_web"."agent_personas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"system_prompt" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_personas_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "claude_agent_web"."agent_projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"path" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_projects_path_unique" UNIQUE("path")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "claude_agent_web"."agent_session_personas" (
	"session_id" text PRIMARY KEY NOT NULL,
	"persona_id" uuid NOT NULL,
	"persona_name" text NOT NULL,
	"system_prompt" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "claude_agent_web"."agent_session_stats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" text NOT NULL,
	"workspace_dir" text NOT NULL,
	"username" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone NOT NULL,
	"life_cycle_ms" bigint NOT NULL,
	"last_active_at" timestamp with time zone NOT NULL,
	"turns" integer DEFAULT 0 NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"close_reason" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "claude_agent_web"."login_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" text NOT NULL,
	"ip" text NOT NULL,
	"success" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "claude_agent_web"."users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" text NOT NULL,
	"role" text DEFAULT 'user' NOT NULL,
	"mfa_secret_enc" text,
	"mfa_bound_at" timestamp with time zone,
	"totp_last_counter" bigint,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_session_stats_username_idx" ON "claude_agent_web"."agent_session_stats" USING btree ("username");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "login_attempts_username_created_idx" ON "claude_agent_web"."login_attempts" USING btree ("username","created_at");
