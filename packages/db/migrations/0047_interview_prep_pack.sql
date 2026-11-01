CREATE TABLE "interview_prep_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"publication_id" uuid NOT NULL,
	"question_key" text NOT NULL,
	"question_text" text NOT NULL,
	"note" text,
	"shown" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "interview_prep_entries_key_check" CHECK (char_length("interview_prep_entries"."question_key") between 1 and 100),
	CONSTRAINT "interview_prep_entries_text_check" CHECK (char_length("interview_prep_entries"."question_text") between 1 and 400),
	CONSTRAINT "interview_prep_entries_note_check" CHECK ("interview_prep_entries"."note" is null or char_length("interview_prep_entries"."note") between 1 and 2000),
	CONSTRAINT "interview_prep_entries_nonempty_check" CHECK ("interview_prep_entries"."note" is not null or "interview_prep_entries"."shown")
);
--> statement-breakpoint
ALTER TABLE "interview_prep_entries" ADD CONSTRAINT "interview_prep_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_prep_entries" ADD CONSTRAINT "interview_prep_entries_publication_id_publications_id_fk" FOREIGN KEY ("publication_id") REFERENCES "public"."publications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "interview_prep_entries_key" ON "interview_prep_entries" USING btree ("user_id","publication_id","question_key");--> statement-breakpoint
CREATE INDEX "interview_prep_entries_publication_idx" ON "interview_prep_entries" USING btree ("publication_id");