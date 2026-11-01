CREATE TYPE "public"."course_hub_notice_kind" AS ENUM('open_notify', 'note_request');--> statement-breakpoint
CREATE TABLE "course_hub_notices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"course_id" uuid NOT NULL,
	"kind" "course_hub_notice_kind" NOT NULL,
	"opened_at" timestamp with time zone,
	"dismissed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "course_hub_notices_opened_check" CHECK ("course_hub_notices"."opened_at" is null or "course_hub_notices"."kind" = 'open_notify'),
	CONSTRAINT "course_hub_notices_note_request_check" CHECK ("course_hub_notices"."kind" <> 'note_request' or "course_hub_notices"."dismissed_at" is not null)
);
--> statement-breakpoint
ALTER TABLE "course_hub_notices" ADD CONSTRAINT "course_hub_notices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_hub_notices" ADD CONSTRAINT "course_hub_notices_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "course_hub_notices_user_course_kind_key" ON "course_hub_notices" USING btree ("user_id","course_id","kind");--> statement-breakpoint
CREATE INDEX "course_hub_notices_course_idx" ON "course_hub_notices" USING btree ("course_id");