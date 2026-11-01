CREATE TYPE "public"."concept_tag_proposal_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."curator_recommendation" AS ENUM('dismiss', 'hide');--> statement-breakpoint
CREATE TABLE "concept_tag_merge_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"course_id" uuid NOT NULL,
	"source_tag_id" uuid NOT NULL,
	"target_tag_id" uuid NOT NULL,
	"proposed_by" uuid,
	"note" text,
	"status" "concept_tag_proposal_status" DEFAULT 'pending' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "concept_tag_merge_proposals_distinct_check" CHECK ("concept_tag_merge_proposals"."source_tag_id" <> "concept_tag_merge_proposals"."target_tag_id"),
	CONSTRAINT "concept_tag_merge_proposals_note_check" CHECK ("concept_tag_merge_proposals"."note" is null or char_length("concept_tag_merge_proposals"."note") between 1 and 300),
	CONSTRAINT "concept_tag_merge_proposals_decided_check" CHECK (("concept_tag_merge_proposals"."status" = 'pending') = ("concept_tag_merge_proposals"."decided_at" is null))
);
--> statement-breakpoint
CREATE TABLE "course_curators" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"course_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"granted_by" uuid,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"show_in_portfolio" boolean DEFAULT false NOT NULL,
	CONSTRAINT "course_curators_revoked_check" CHECK ("course_curators"."revoked_at" is not null or "course_curators"."revoked_by" is null)
);
--> statement-breakpoint
CREATE TABLE "course_type_summaries" (
	"course_id" uuid PRIMARY KEY NOT NULL,
	"body" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "course_type_summaries_body_check" CHECK (char_length("course_type_summaries"."body") between 1 and 1000),
	CONSTRAINT "course_type_summaries_version_check" CHECK ("course_type_summaries"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "curator_report_recommendations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"report_id" uuid NOT NULL,
	"target_key" text NOT NULL,
	"course_id" uuid NOT NULL,
	"curator_id" uuid,
	"recommendation" "curator_recommendation" NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "curator_report_recommendations_note_check" CHECK ("curator_report_recommendations"."note" is null or char_length("curator_report_recommendations"."note") between 1 and 300)
);
--> statement-breakpoint
ALTER TABLE "concept_tag_merge_proposals" ADD CONSTRAINT "concept_tag_merge_proposals_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concept_tag_merge_proposals" ADD CONSTRAINT "concept_tag_merge_proposals_source_tag_id_concept_tags_id_fk" FOREIGN KEY ("source_tag_id") REFERENCES "public"."concept_tags"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concept_tag_merge_proposals" ADD CONSTRAINT "concept_tag_merge_proposals_target_tag_id_concept_tags_id_fk" FOREIGN KEY ("target_tag_id") REFERENCES "public"."concept_tags"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concept_tag_merge_proposals" ADD CONSTRAINT "concept_tag_merge_proposals_proposed_by_users_id_fk" FOREIGN KEY ("proposed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concept_tag_merge_proposals" ADD CONSTRAINT "concept_tag_merge_proposals_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_curators" ADD CONSTRAINT "course_curators_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_curators" ADD CONSTRAINT "course_curators_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_curators" ADD CONSTRAINT "course_curators_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_curators" ADD CONSTRAINT "course_curators_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_type_summaries" ADD CONSTRAINT "course_type_summaries_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_type_summaries" ADD CONSTRAINT "course_type_summaries_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "curator_report_recommendations" ADD CONSTRAINT "curator_report_recommendations_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "curator_report_recommendations" ADD CONSTRAINT "curator_report_recommendations_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "curator_report_recommendations" ADD CONSTRAINT "curator_report_recommendations_curator_id_users_id_fk" FOREIGN KEY ("curator_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "concept_tag_merge_proposals_pending_key" ON "concept_tag_merge_proposals" USING btree ("source_tag_id","target_tag_id") WHERE "concept_tag_merge_proposals"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "concept_tag_merge_proposals_course_idx" ON "concept_tag_merge_proposals" USING btree ("course_id");--> statement-breakpoint
CREATE INDEX "concept_tag_merge_proposals_status_idx" ON "concept_tag_merge_proposals" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "course_curators_open_key" ON "course_curators" USING btree ("course_id","user_id") WHERE "course_curators"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "course_curators_user_id_idx" ON "course_curators" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "curator_report_recommendations_report_curator_key" ON "curator_report_recommendations" USING btree ("report_id","curator_id");--> statement-breakpoint
CREATE INDEX "curator_report_recommendations_target_key_idx" ON "curator_report_recommendations" USING btree ("target_key");