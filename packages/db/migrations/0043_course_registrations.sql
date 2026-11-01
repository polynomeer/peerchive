CREATE TABLE "course_registrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"course_term_id" uuid NOT NULL,
	"post_term_prompted_at" timestamp with time zone,
	"prompt_dismissed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "course_registrations_dismissed_check" CHECK ("course_registrations"."prompt_dismissed_at" is null or "course_registrations"."post_term_prompted_at" is not null)
);
--> statement-breakpoint
ALTER TABLE "course_registrations" ADD CONSTRAINT "course_registrations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_registrations" ADD CONSTRAINT "course_registrations_course_term_id_course_terms_id_fk" FOREIGN KEY ("course_term_id") REFERENCES "public"."course_terms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "course_registrations_user_term_key" ON "course_registrations" USING btree ("user_id","course_term_id");--> statement-breakpoint
CREATE INDEX "course_registrations_course_term_idx" ON "course_registrations" USING btree ("course_term_id");--> statement-breakpoint
CREATE INDEX "course_registrations_prompt_due_idx" ON "course_registrations" USING btree ("course_term_id") WHERE "course_registrations"."post_term_prompted_at" is null;