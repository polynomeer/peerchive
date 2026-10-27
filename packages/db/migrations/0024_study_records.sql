ALTER TYPE "public"."analytics_event_name" ADD VALUE 'study_record_enabled';--> statement-breakpoint
ALTER TYPE "public"."project_kind" ADD VALUE 'study';--> statement-breakpoint
CREATE TABLE "study_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"enabled_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "study_name_mode" "community_name_mode";--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "study_school_id" uuid;--> statement-breakpoint
ALTER TABLE "study_records" ADD CONSTRAINT "study_records_space_id_community_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."community_spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "study_records" ADD CONSTRAINT "study_records_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "study_records" ADD CONSTRAINT "study_records_enabled_by_users_id_fk" FOREIGN KEY ("enabled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "study_records_space_id_key" ON "study_records" USING btree ("space_id");--> statement-breakpoint
CREATE UNIQUE INDEX "study_records_project_id_key" ON "study_records" USING btree ("project_id");--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_study_school_id_schools_id_fk" FOREIGN KEY ("study_school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_study_name_mode_check" CHECK (("projects"."kind"::text = 'study') = ("projects"."study_name_mode" is not null));--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_study_school_check" CHECK ("projects"."study_school_id" is null or "projects"."kind"::text = 'study');