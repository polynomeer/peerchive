CREATE TYPE "public"."search_doc_kind" AS ENUM('case', 'stuck', 'note');--> statement-breakpoint
CREATE TYPE "public"."senior_note_display_mode" AS ENUM('name', 'display', 'anonymous');--> statement-breakpoint
CREATE TYPE "public"."senior_note_status" AS ENUM('draft', 'published', 'withdrawn', 'hidden');--> statement-breakpoint
CREATE TYPE "public"."senior_note_time_bucket" AS ENUM('lt10h', 'lt20h', 'lt40h', 'forty_plus');--> statement-breakpoint
CREATE TYPE "public"."signal_kind" AS ENUM('me_too', 'helped');--> statement-breakpoint
CREATE TYPE "public"."signal_target_kind" AS ENUM('stuck_item', 'senior_note');--> statement-breakpoint
CREATE TABLE "plan_forks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_publication_id" uuid NOT NULL,
	"source_release_id" uuid NOT NULL,
	"release_version" integer NOT NULL,
	"target_project_id" uuid NOT NULL,
	"forked_by" uuid NOT NULL,
	"copied" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plan_forks_target_project_id_unique" UNIQUE("target_project_id"),
	CONSTRAINT "plan_forks_source_user_key" UNIQUE("source_publication_id","forked_by"),
	CONSTRAINT "plan_forks_release_version_check" CHECK ("plan_forks"."release_version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "search_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "search_doc_kind" NOT NULL,
	"publication_id" uuid,
	"release_id" uuid,
	"item_key" text,
	"senior_note_id" uuid,
	"note_version" integer,
	"title" text NOT NULL,
	"snippet" text NOT NULL,
	"search_text" text NOT NULL,
	"indexed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "search_documents_target_check" CHECK (("search_documents"."kind" in ('case', 'stuck') and "search_documents"."publication_id" is not null and "search_documents"."release_id" is not null and "search_documents"."senior_note_id" is null
          and (("search_documents"."kind" = 'case') = ("search_documents"."item_key" is null)))
        or ("search_documents"."kind" = 'note' and "search_documents"."senior_note_id" is not null and "search_documents"."note_version" is not null and "search_documents"."publication_id" is null and "search_documents"."release_id" is null))
);
--> statement-breakpoint
CREATE TABLE "senior_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"course_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"display_mode" "senior_note_display_mode" NOT NULL,
	"display_name_snapshot" text,
	"term_label" text,
	"total_time_bucket" "senior_note_time_bucket",
	"answers" jsonb NOT NULL,
	"no_answers_confirmed" boolean NOT NULL,
	"status" "senior_note_status" DEFAULT 'draft' NOT NULL,
	"published_at" timestamp with time zone,
	"withdrawn_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "senior_notes_answers_object_check" CHECK (jsonb_typeof("senior_notes"."answers") = 'object'),
	CONSTRAINT "senior_notes_confirmed_check" CHECK ("senior_notes"."no_answers_confirmed"),
	CONSTRAINT "senior_notes_version_check" CHECK ("senior_notes"."version" >= 1),
	CONSTRAINT "senior_notes_display_name_check" CHECK ("senior_notes"."display_name_snapshot" is null or char_length("senior_notes"."display_name_snapshot") between 1 and 80),
	CONSTRAINT "senior_notes_term_label_check" CHECK ("senior_notes"."term_label" is null or char_length("senior_notes"."term_label") between 1 and 30),
	CONSTRAINT "senior_notes_published_check" CHECK ("senior_notes"."status" <> 'published' or "senior_notes"."published_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "usefulness_signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"target_kind" "signal_target_kind" NOT NULL,
	"publication_id" uuid,
	"item_key" text,
	"senior_note_id" uuid,
	"kind" "signal_kind" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usefulness_signals_target_check" CHECK (("usefulness_signals"."target_kind" = 'stuck_item' and "usefulness_signals"."publication_id" is not null and "usefulness_signals"."item_key" is not null and "usefulness_signals"."senior_note_id" is null)
        or ("usefulness_signals"."target_kind" = 'senior_note' and "usefulness_signals"."senior_note_id" is not null and "usefulness_signals"."publication_id" is null and "usefulness_signals"."item_key" is null)),
	CONSTRAINT "usefulness_signals_item_key_check" CHECK ("usefulness_signals"."item_key" is null or char_length("usefulness_signals"."item_key") between 1 and 40)
);
--> statement-breakpoint
ALTER TABLE "publication_candidates" ADD COLUMN "course_id" uuid;--> statement-breakpoint
ALTER TABLE "publication_candidates" ADD COLUMN "term_label" text;--> statement-breakpoint
ALTER TABLE "plan_forks" ADD CONSTRAINT "plan_forks_source_publication_id_publications_id_fk" FOREIGN KEY ("source_publication_id") REFERENCES "public"."publications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_forks" ADD CONSTRAINT "plan_forks_source_release_id_publication_candidates_id_fk" FOREIGN KEY ("source_release_id") REFERENCES "public"."publication_candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_forks" ADD CONSTRAINT "plan_forks_target_project_id_projects_id_fk" FOREIGN KEY ("target_project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_forks" ADD CONSTRAINT "plan_forks_forked_by_users_id_fk" FOREIGN KEY ("forked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_documents" ADD CONSTRAINT "search_documents_publication_id_publications_id_fk" FOREIGN KEY ("publication_id") REFERENCES "public"."publications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_documents" ADD CONSTRAINT "search_documents_release_id_publication_candidates_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."publication_candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_documents" ADD CONSTRAINT "search_documents_senior_note_id_senior_notes_id_fk" FOREIGN KEY ("senior_note_id") REFERENCES "public"."senior_notes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "senior_notes" ADD CONSTRAINT "senior_notes_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "senior_notes" ADD CONSTRAINT "senior_notes_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usefulness_signals" ADD CONSTRAINT "usefulness_signals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usefulness_signals" ADD CONSTRAINT "usefulness_signals_publication_id_publications_id_fk" FOREIGN KEY ("publication_id") REFERENCES "public"."publications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usefulness_signals" ADD CONSTRAINT "usefulness_signals_senior_note_id_senior_notes_id_fk" FOREIGN KEY ("senior_note_id") REFERENCES "public"."senior_notes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "plan_forks_forked_by_idx" ON "plan_forks" USING btree ("forked_by");--> statement-breakpoint
CREATE UNIQUE INDEX "search_documents_case_key" ON "search_documents" USING btree ("release_id") WHERE "search_documents"."kind" = 'case';--> statement-breakpoint
CREATE UNIQUE INDEX "search_documents_stuck_key" ON "search_documents" USING btree ("release_id","item_key") WHERE "search_documents"."kind" = 'stuck';--> statement-breakpoint
CREATE UNIQUE INDEX "search_documents_note_key" ON "search_documents" USING btree ("senior_note_id") WHERE "search_documents"."kind" = 'note';--> statement-breakpoint
CREATE INDEX "search_documents_publication_idx" ON "search_documents" USING btree ("publication_id");--> statement-breakpoint
CREATE INDEX "search_documents_search_text_trgm_idx" ON "search_documents" USING gin ("search_text" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "senior_notes_course_published_idx" ON "senior_notes" USING btree ("course_id","published_at" DESC NULLS LAST) WHERE "senior_notes"."status" = 'published';--> statement-breakpoint
CREATE INDEX "senior_notes_author_id_idx" ON "senior_notes" USING btree ("author_id");--> statement-breakpoint
CREATE UNIQUE INDEX "usefulness_signals_stuck_key" ON "usefulness_signals" USING btree ("user_id","publication_id","item_key","kind") WHERE "usefulness_signals"."target_kind" = 'stuck_item';--> statement-breakpoint
CREATE UNIQUE INDEX "usefulness_signals_note_key" ON "usefulness_signals" USING btree ("user_id","senior_note_id","kind") WHERE "usefulness_signals"."target_kind" = 'senior_note';--> statement-breakpoint
CREATE INDEX "usefulness_signals_publication_idx" ON "usefulness_signals" USING btree ("publication_id","item_key");--> statement-breakpoint
CREATE INDEX "usefulness_signals_note_idx" ON "usefulness_signals" USING btree ("senior_note_id");--> statement-breakpoint
ALTER TABLE "publication_candidates" ADD CONSTRAINT "publication_candidates_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "publication_candidates_course_published_idx" ON "publication_candidates" USING btree ("course_id") WHERE "publication_candidates"."status" = 'published';