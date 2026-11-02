CREATE TYPE "public"."ai_retro_session_status" AS ENUM('active', 'drafted');--> statement-breakpoint
ALTER TYPE "public"."analytics_event_name" ADD VALUE 'ai_retro_drafts_proposed';--> statement-breakpoint
ALTER TYPE "public"."analytics_event_name" ADD VALUE 'ai_retro_draft_resolved';--> statement-breakpoint
CREATE TABLE "ai_retro_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"tag" "log_tag" NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_retro_drafts_session_position_key" UNIQUE("session_id","position"),
	CONSTRAINT "ai_retro_drafts_payload_object_check" CHECK (jsonb_typeof("ai_retro_drafts"."payload") = 'object'),
	CONSTRAINT "ai_retro_drafts_tag_check" CHECK ("ai_retro_drafts"."tag"::text in ('progress', 'stuck', 'decision', 'validation', 'retro'))
);
--> statement-breakpoint
CREATE TABLE "ai_retro_opt_ins" (
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_retro_opt_ins_pkey" PRIMARY KEY("project_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "ai_retro_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" "ai_retro_session_status" DEFAULT 'active' NOT NULL,
	"transcript" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"question_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ai_retro_sessions_project_user_key" UNIQUE("project_id","user_id"),
	CONSTRAINT "ai_retro_sessions_transcript_array_check" CHECK (jsonb_typeof("ai_retro_sessions"."transcript") = 'array'),
	CONSTRAINT "ai_retro_sessions_question_count_check" CHECK ("ai_retro_sessions"."question_count" between 0 and 10)
);
--> statement-breakpoint
CREATE TABLE "ai_usage_daily" (
	"day" date NOT NULL,
	"feature" text NOT NULL,
	"model" text NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_read_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_creation_tokens" bigint DEFAULT 0 NOT NULL,
	"refusals" integer DEFAULT 0 NOT NULL,
	"fallbacks" integer DEFAULT 0 NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "ai_usage_daily_pkey" PRIMARY KEY("day","feature","model"),
	CONSTRAINT "ai_usage_daily_feature_check" CHECK (char_length("ai_usage_daily"."feature") between 1 and 64)
);
--> statement-breakpoint
ALTER TABLE "ai_retro_drafts" ADD CONSTRAINT "ai_retro_drafts_session_id_ai_retro_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."ai_retro_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_retro_drafts" ADD CONSTRAINT "ai_retro_drafts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_retro_drafts" ADD CONSTRAINT "ai_retro_drafts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_retro_opt_ins" ADD CONSTRAINT "ai_retro_opt_ins_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_retro_opt_ins" ADD CONSTRAINT "ai_retro_opt_ins_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_retro_sessions" ADD CONSTRAINT "ai_retro_sessions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_retro_sessions" ADD CONSTRAINT "ai_retro_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_retro_drafts_project_user_idx" ON "ai_retro_drafts" USING btree ("project_id","user_id");--> statement-breakpoint
CREATE INDEX "ai_retro_opt_ins_user_idx" ON "ai_retro_opt_ins" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ai_retro_sessions_user_idx" ON "ai_retro_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ai_retro_sessions_expires_at_idx" ON "ai_retro_sessions" USING btree ("expires_at");