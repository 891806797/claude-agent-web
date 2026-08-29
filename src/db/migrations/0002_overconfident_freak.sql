CREATE TABLE "agent_projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"path" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_projects_path_unique" UNIQUE("path")
);
--> statement-breakpoint
CREATE TABLE "agent_session_stats" (
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
CREATE INDEX "agent_session_stats_username_idx" ON "agent_session_stats" USING btree ("username");