CREATE TABLE IF NOT EXISTS "claude_agent_web"."agent_session_run_modes" (
	"session_id" text PRIMARY KEY NOT NULL,
	"run_mode" text DEFAULT 'standard' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
