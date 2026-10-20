CREATE TYPE "public"."checkin_time_bucket" AS ENUM('none', 'lt2h', 'lt5h', 'lt10h', 'ten_plus');--> statement-breakpoint
CREATE TYPE "public"."discord_code_kind" AS ENUM('link', 'bind');--> statement-breakpoint
CREATE TYPE "public"."discord_notice_kind" AS ENUM('checkin_reminder', 'weekly_summary');--> statement-breakpoint
CREATE TYPE "public"."integration_provider" AS ENUM('discord', 'github');--> statement-breakpoint
CREATE TYPE "public"."pin_request_status" AS ENUM('pending', 'approved', 'rejected', 'expired');--> statement-breakpoint
CREATE TABLE "discord_channel_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"guild_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"label" text,
	"summary_enabled" boolean DEFAULT false NOT NULL,
	"bound_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"unbound_at" timestamp with time zone,
	CONSTRAINT "discord_channel_bindings_label_check" CHECK ("discord_channel_bindings"."label" is null or char_length("discord_channel_bindings"."label") <= 100)
);
--> statement-breakpoint
CREATE TABLE "discord_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "discord_code_kind" NOT NULL,
	"code_hash" text NOT NULL,
	"user_id" uuid NOT NULL,
	"project_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "discord_codes_code_hash_unique" UNIQUE("code_hash"),
	CONSTRAINT "discord_codes_project_check" CHECK (("discord_codes"."kind" = 'bind') = ("discord_codes"."project_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "discord_notices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"binding_id" uuid NOT NULL,
	"kind" "discord_notice_kind" NOT NULL,
	"iso_week" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"delivered_at" timestamp with time zone,
	"failed_reason" text,
	"discord_message_id" text,
	CONSTRAINT "discord_notices_binding_kind_week_key" UNIQUE("binding_id","kind","iso_week"),
	CONSTRAINT "discord_notices_iso_week_check" CHECK ("discord_notices"."iso_week" ~ '^[0-9]{4}-W[0-9]{2}$')
);
--> statement-breakpoint
CREATE TABLE "discord_pin_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"binding_id" uuid NOT NULL,
	"message_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"author_external_id" text NOT NULL,
	"author_user_id" uuid NOT NULL,
	"requester_user_id" uuid NOT NULL,
	"content" text,
	"status" "pin_request_status" DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	"log_entry_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "discord_pin_requests_message_id_unique" UNIQUE("message_id"),
	CONSTRAINT "discord_pin_requests_content_check" CHECK ("discord_pin_requests"."status" = 'pending' or "discord_pin_requests"."content" is null)
);
--> statement-breakpoint
CREATE TABLE "integrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" "integration_provider" NOT NULL,
	"external_id" text NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "internal_request_nonces" (
	"nonce" text PRIMARY KEY NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "weekly_checkins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"iso_week" text NOT NULL,
	"time_bucket" "checkin_time_bucket" NOT NULL,
	"difficulty" integer NOT NULL,
	"note" text,
	"promoted_log_entry_id" uuid,
	"share_for_stats" boolean DEFAULT false NOT NULL,
	"skip_reasons" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "weekly_checkins_project_user_week_key" UNIQUE("project_id","user_id","iso_week"),
	CONSTRAINT "weekly_checkins_iso_week_check" CHECK ("weekly_checkins"."iso_week" ~ '^[0-9]{4}-W[0-9]{2}$'),
	CONSTRAINT "weekly_checkins_difficulty_check" CHECK ("weekly_checkins"."difficulty" between 1 and 5),
	CONSTRAINT "weekly_checkins_note_check" CHECK ("weekly_checkins"."note" is null or char_length("weekly_checkins"."note") between 1 and 200)
);
--> statement-breakpoint
ALTER TABLE "discord_channel_bindings" ADD CONSTRAINT "discord_channel_bindings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discord_channel_bindings" ADD CONSTRAINT "discord_channel_bindings_bound_by_users_id_fk" FOREIGN KEY ("bound_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discord_codes" ADD CONSTRAINT "discord_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discord_codes" ADD CONSTRAINT "discord_codes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discord_notices" ADD CONSTRAINT "discord_notices_binding_id_discord_channel_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."discord_channel_bindings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discord_pin_requests" ADD CONSTRAINT "discord_pin_requests_binding_id_discord_channel_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."discord_channel_bindings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discord_pin_requests" ADD CONSTRAINT "discord_pin_requests_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discord_pin_requests" ADD CONSTRAINT "discord_pin_requests_requester_user_id_users_id_fk" FOREIGN KEY ("requester_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discord_pin_requests" ADD CONSTRAINT "discord_pin_requests_log_entry_id_log_entries_id_fk" FOREIGN KEY ("log_entry_id") REFERENCES "public"."log_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_checkins" ADD CONSTRAINT "weekly_checkins_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_checkins" ADD CONSTRAINT "weekly_checkins_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_checkins" ADD CONSTRAINT "weekly_checkins_promoted_log_entry_id_log_entries_id_fk" FOREIGN KEY ("promoted_log_entry_id") REFERENCES "public"."log_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "discord_channel_bindings_channel_active_key" ON "discord_channel_bindings" USING btree ("channel_id") WHERE "discord_channel_bindings"."unbound_at" is null;--> statement-breakpoint
CREATE INDEX "discord_channel_bindings_project_id_idx" ON "discord_channel_bindings" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "discord_codes_user_id_idx" ON "discord_codes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "discord_notices_undelivered_idx" ON "discord_notices" USING btree ("created_at") WHERE "discord_notices"."delivered_at" is null;--> statement-breakpoint
CREATE INDEX "discord_pin_requests_pending_idx" ON "discord_pin_requests" USING btree ("expires_at") WHERE "discord_pin_requests"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "integrations_provider_external_active_key" ON "integrations" USING btree ("provider","external_id") WHERE "integrations"."revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "integrations_user_provider_active_key" ON "integrations" USING btree ("user_id","provider") WHERE "integrations"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "internal_request_nonces_received_at_idx" ON "internal_request_nonces" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "weekly_checkins_project_week_idx" ON "weekly_checkins" USING btree ("project_id","iso_week");