CREATE TYPE "public"."task_status" AS ENUM('todo', 'doing', 'done');--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"title" text NOT NULL,
	"note" text,
	"assignee_id" uuid,
	"due_at" date,
	"status" "task_status" DEFAULT 'todo' NOT NULL,
	"position" integer NOT NULL,
	"completed_at" timestamp with time zone,
	"completed_by" uuid,
	"log_entry_id" uuid,
	"created_by" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tasks_project_status_position_key" UNIQUE("project_id","status","position"),
	CONSTRAINT "tasks_log_entry_id_key" UNIQUE("log_entry_id"),
	CONSTRAINT "tasks_position_check" CHECK ("tasks"."position" >= 1),
	CONSTRAINT "tasks_title_check" CHECK (char_length("tasks"."title") between 1 and 120),
	CONSTRAINT "tasks_note_check" CHECK ("tasks"."note" is null or char_length("tasks"."note") <= 1000),
	CONSTRAINT "tasks_version_check" CHECK ("tasks"."version" >= 1),
	CONSTRAINT "tasks_completed_check" CHECK (("tasks"."status" = 'done') = ("tasks"."completed_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "log_entries" ADD COLUMN "retrospective" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "milestone_snapshots" ADD COLUMN "retrospective" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "milestones" ADD COLUMN "retrospective" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_completed_by_users_id_fk" FOREIGN KEY ("completed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_log_entry_id_log_entries_id_fk" FOREIGN KEY ("log_entry_id") REFERENCES "public"."log_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tasks_assignee_id_idx" ON "tasks" USING btree ("assignee_id");