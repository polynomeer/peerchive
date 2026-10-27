CREATE TYPE "public"."community_notice_kind" AS ENUM('name_mode_scheduled', 'name_mode_cancelled', 'name_mode_applied');--> statement-breakpoint
CREATE TYPE "public"."name_mode_change_status" AS ENUM('scheduled', 'applied', 'cancelled');--> statement-breakpoint
ALTER TYPE "public"."analytics_event_name" ADD VALUE 'name_mode_scheduled';--> statement-breakpoint
ALTER TYPE "public"."analytics_event_name" ADD VALUE 'name_mode_applied';--> statement-breakpoint
CREATE TABLE "community_notices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"kind" "community_notice_kind" NOT NULL,
	"name_mode_change_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone,
	CONSTRAINT "community_notices_payload_object_check" CHECK (jsonb_typeof("community_notices"."payload") = 'object')
);
--> statement-breakpoint
CREATE TABLE "name_mode_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" uuid NOT NULL,
	"from_mode" "community_name_mode" NOT NULL,
	"to_mode" "community_name_mode" NOT NULL,
	"requested_by" uuid,
	"requested_at" timestamp with time zone NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"status" "name_mode_change_status" DEFAULT 'scheduled' NOT NULL,
	"applied_at" timestamp with time zone,
	"cancelled_by" uuid,
	"cancelled_at" timestamp with time zone,
	"join_policy_adjusted" boolean DEFAULT false NOT NULL,
	CONSTRAINT "name_mode_changes_modes_check" CHECK ("name_mode_changes"."from_mode" <> "name_mode_changes"."to_mode"),
	CONSTRAINT "name_mode_changes_delay_check" CHECK ("name_mode_changes"."effective_at" = "name_mode_changes"."requested_at" + interval '7 days'),
	CONSTRAINT "name_mode_changes_applied_check" CHECK (("name_mode_changes"."status" = 'applied') = ("name_mode_changes"."applied_at" is not null)),
	CONSTRAINT "name_mode_changes_cancelled_check" CHECK (("name_mode_changes"."status" = 'cancelled') = ("name_mode_changes"."cancelled_at" is not null)),
	CONSTRAINT "name_mode_changes_cancelled_by_check" CHECK ("name_mode_changes"."cancelled_by" is null or "name_mode_changes"."status" = 'cancelled')
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "real_name" text;--> statement-breakpoint
ALTER TABLE "community_notices" ADD CONSTRAINT "community_notices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_notices" ADD CONSTRAINT "community_notices_space_id_community_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."community_spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_notices" ADD CONSTRAINT "community_notices_name_mode_change_id_name_mode_changes_id_fk" FOREIGN KEY ("name_mode_change_id") REFERENCES "public"."name_mode_changes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "name_mode_changes" ADD CONSTRAINT "name_mode_changes_space_id_community_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."community_spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "name_mode_changes" ADD CONSTRAINT "name_mode_changes_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "name_mode_changes" ADD CONSTRAINT "name_mode_changes_cancelled_by_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "community_notices_change_kind_user_key" ON "community_notices" USING btree ("name_mode_change_id","kind","user_id") WHERE "community_notices"."name_mode_change_id" is not null;--> statement-breakpoint
CREATE INDEX "community_notices_user_created_idx" ON "community_notices" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "name_mode_changes_one_scheduled_key" ON "name_mode_changes" USING btree ("space_id") WHERE "name_mode_changes"."status" = 'scheduled';--> statement-breakpoint
CREATE INDEX "name_mode_changes_space_requested_idx" ON "name_mode_changes" USING btree ("space_id","requested_at");--> statement-breakpoint
CREATE INDEX "name_mode_changes_due_idx" ON "name_mode_changes" USING btree ("effective_at") WHERE "name_mode_changes"."status" = 'scheduled';--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_real_name_check" CHECK ("users"."real_name" is null or char_length("users"."real_name") between 1 and 30);