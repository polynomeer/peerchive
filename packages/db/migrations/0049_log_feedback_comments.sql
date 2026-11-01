CREATE TYPE "public"."log_comment_status" AS ENUM('published', 'deleted', 'hidden');--> statement-breakpoint
CREATE TABLE "log_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"log_entry_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"revision_no" integer NOT NULL,
	"body" text NOT NULL,
	"status" "log_comment_status" DEFAULT 'published' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"edited_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"hidden_at" timestamp with time zone,
	CONSTRAINT "log_comments_revision_no_check" CHECK ("log_comments"."revision_no" >= 1),
	CONSTRAINT "log_comments_body_check" CHECK (("log_comments"."status"::text = 'deleted' and "log_comments"."body" = '') or ("log_comments"."status"::text <> 'deleted' and char_length("log_comments"."body") between 1 and 2000)),
	CONSTRAINT "log_comments_deleted_check" CHECK (("log_comments"."status"::text = 'deleted') = ("log_comments"."deleted_at" is not null)),
	CONSTRAINT "log_comments_hidden_check" CHECK (("log_comments"."status"::text = 'hidden') = ("log_comments"."hidden_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "log_comments" ADD CONSTRAINT "log_comments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "log_comments" ADD CONSTRAINT "log_comments_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "log_entries" ADD CONSTRAINT "log_entries_id_project_key" UNIQUE("id","project_id");--> statement-breakpoint
ALTER TABLE "log_comments" ADD CONSTRAINT "log_comments_log_entry_project_fk" FOREIGN KEY ("log_entry_id","project_id") REFERENCES "public"."log_entries"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "log_comments_entry_created_idx" ON "log_comments" USING btree ("log_entry_id","created_at","id");--> statement-breakpoint
CREATE INDEX "log_comments_project_idx" ON "log_comments" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "log_comments_author_idx" ON "log_comments" USING btree ("author_id");