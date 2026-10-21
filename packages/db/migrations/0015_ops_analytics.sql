CREATE TYPE "public"."analytics_event_name" AS ENUM('project_created', 'log_saved', 'evidence_attached', 'milestone_snapshot_set', 'checkin_submitted', 'claim_endorsed', 'report_exported', 'candidate_prepared', 'consent_completed', 'publication_published', 'publication_withdrawn', 'plan_forked', 'usefulness_marked', 'senior_note_published', 'portfolio_shared', 'login_succeeded');--> statement-breakpoint
CREATE TABLE "analytics_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" "analytics_event_name" NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_hash" text NOT NULL,
	"project_hash" text,
	"hash_key_id" text NOT NULL,
	"props" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "analytics_events_actor_hash_check" CHECK ("analytics_events"."actor_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "analytics_events_project_hash_check" CHECK ("analytics_events"."project_hash" is null or "analytics_events"."project_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "analytics_events_hash_key_id_check" CHECK ("analytics_events"."hash_key_id" ~ '^[0-9a-f]{8}$'),
	CONSTRAINT "analytics_events_props_object_check" CHECK (jsonb_typeof("analytics_events"."props") = 'object')
);
--> statement-breakpoint
CREATE TABLE "deletion_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_hash" text NOT NULL,
	"entity_kind" text NOT NULL,
	"count" integer NOT NULL,
	"requested_at" timestamp with time zone,
	"purged_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" text DEFAULT 'purge' NOT NULL,
	CONSTRAINT "deletion_ledger_subject_hash_check" CHECK ("deletion_ledger"."subject_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "deletion_ledger_entity_kind_check" CHECK ("deletion_ledger"."entity_kind" ~ '^[a-z_]{1,40}$'),
	CONSTRAINT "deletion_ledger_count_check" CHECK ("deletion_ledger"."count" >= 0),
	CONSTRAINT "deletion_ledger_source_check" CHECK ("deletion_ledger"."source" in ('purge', 'reapply'))
);
--> statement-breakpoint
CREATE TABLE "worker_heartbeats" (
	"name" text PRIMARY KEY NOT NULL,
	"beat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "worker_heartbeats_name_check" CHECK ("worker_heartbeats"."name" ~ '^[a-z0-9:_.-]{1,60}$'),
	CONSTRAINT "worker_heartbeats_details_object_check" CHECK (jsonb_typeof("worker_heartbeats"."details") = 'object')
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "purged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "analytics_opt_out" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "analytics_events_name_occurred_idx" ON "analytics_events" USING btree ("name","occurred_at");--> statement-breakpoint
CREATE INDEX "analytics_events_actor_occurred_idx" ON "analytics_events" USING btree ("actor_hash","occurred_at");--> statement-breakpoint
CREATE INDEX "deletion_ledger_subject_hash_idx" ON "deletion_ledger" USING btree ("subject_hash");