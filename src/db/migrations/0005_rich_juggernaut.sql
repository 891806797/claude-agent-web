CREATE TABLE IF NOT EXISTS "agent_personas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"system_prompt" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_personas_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_session_personas" (
	"session_id" text PRIMARY KEY NOT NULL,
	"persona_id" uuid NOT NULL,
	"persona_name" text NOT NULL,
	"system_prompt" text NOT NULL
);
