-- T-06 마일스톤·스냅샷, 로그 revision의 마일스톤 연결. 순서(position)는 애플리케이션이 1부터 빈틈없이 다시 매깁니다.
CREATE TABLE "milestone_snapshots" (
	"milestone_id" uuid NOT NULL,
	"artifact_version_id" uuid NOT NULL,
	"note" text,
	"position" integer NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "milestone_snapshots_pkey" PRIMARY KEY("milestone_id","artifact_version_id"),
	CONSTRAINT "milestone_snapshots_position_check" CHECK ("milestone_snapshots"."position" >= 1),
	CONSTRAINT "milestone_snapshots_note_check" CHECK ("milestone_snapshots"."note" is null or char_length("milestone_snapshots"."note") <= 300)
);
--> statement-breakpoint
CREATE TABLE "milestones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"title" text NOT NULL,
	"note" text,
	"due_at" date,
	"claimed_at" date,
	"created_by" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "milestones_project_id_position_key" UNIQUE("project_id","position"),
	CONSTRAINT "milestones_position_check" CHECK ("milestones"."position" >= 1),
	CONSTRAINT "milestones_title_check" CHECK (char_length("milestones"."title") between 1 and 80),
	CONSTRAINT "milestones_note_check" CHECK ("milestones"."note" is null or char_length("milestones"."note") <= 500),
	CONSTRAINT "milestones_version_check" CHECK ("milestones"."version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "log_revisions" ADD COLUMN "milestone_id" uuid;--> statement-breakpoint
ALTER TABLE "milestone_snapshots" ADD CONSTRAINT "milestone_snapshots_milestone_id_milestones_id_fk" FOREIGN KEY ("milestone_id") REFERENCES "public"."milestones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "milestone_snapshots" ADD CONSTRAINT "milestone_snapshots_artifact_version_id_artifact_versions_id_fk" FOREIGN KEY ("artifact_version_id") REFERENCES "public"."artifact_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "milestone_snapshots" ADD CONSTRAINT "milestone_snapshots_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "milestones" ADD CONSTRAINT "milestones_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "milestones" ADD CONSTRAINT "milestones_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "milestone_snapshots_artifact_version_id_idx" ON "milestone_snapshots" USING btree ("artifact_version_id");--> statement-breakpoint
ALTER TABLE "log_revisions" ADD CONSTRAINT "log_revisions_milestone_id_milestones_id_fk" FOREIGN KEY ("milestone_id") REFERENCES "public"."milestones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "log_revisions_milestone_id_idx" ON "log_revisions" USING btree ("milestone_id");