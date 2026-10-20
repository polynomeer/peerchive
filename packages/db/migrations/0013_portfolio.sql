CREATE TYPE "public"."case_job_target" AS ENUM('backend', 'frontend', 'data', 'pm', 'design', 'general');--> statement-breakpoint
CREATE TYPE "public"."case_study_status" AS ENUM('draft', 'published', 'unavailable');--> statement-breakpoint
CREATE TABLE "case_sentences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_study_id" uuid NOT NULL,
	"section" text NOT NULL,
	"position" integer NOT NULL,
	"text" text NOT NULL,
	"kind" text DEFAULT 'evidence' NOT NULL,
	"citations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "case_sentences_position_key" UNIQUE("case_study_id","section","position"),
	CONSTRAINT "case_sentences_section_check" CHECK ("case_sentences"."section" in ('problem_result', 'my_role', 'decisions', 'stuck_solved', 'validation', 'limits', 'sources')),
	CONSTRAINT "case_sentences_kind_check" CHECK ("case_sentences"."kind" in ('evidence', 'reflection') and ("case_sentences"."kind" = 'evidence' or "case_sentences"."section" = 'limits')),
	CONSTRAINT "case_sentences_text_check" CHECK (char_length("case_sentences"."text") between 1 and 500),
	CONSTRAINT "case_sentences_position_check" CHECK ("case_sentences"."position" >= 0),
	CONSTRAINT "case_sentences_citations_array_check" CHECK (jsonb_typeof("case_sentences"."citations") = 'array')
);
--> statement-breakpoint
CREATE TABLE "case_studies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"publication_id" uuid NOT NULL,
	"release_id" uuid NOT NULL,
	"release_version" integer NOT NULL,
	"member_key" text NOT NULL,
	"self_anonymous" boolean NOT NULL,
	"reveal_self" boolean DEFAULT false NOT NULL,
	"job_target" "case_job_target" NOT NULL,
	"generator" text DEFAULT 'template' NOT NULL,
	"title" text NOT NULL,
	"status" "case_study_status" DEFAULT 'draft' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"published_at" timestamp with time zone,
	"unavailable_at" timestamp with time zone,
	"unavailable_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "case_studies_generator_check" CHECK ("case_studies"."generator" in ('template')),
	CONSTRAINT "case_studies_title_check" CHECK (char_length("case_studies"."title") between 1 and 80),
	CONSTRAINT "case_studies_version_check" CHECK ("case_studies"."version" >= 1),
	CONSTRAINT "case_studies_release_version_check" CHECK ("case_studies"."release_version" >= 1),
	CONSTRAINT "case_studies_reveal_check" CHECK (not "case_studies"."self_anonymous" or "case_studies"."reveal_self"),
	CONSTRAINT "case_studies_published_check" CHECK ("case_studies"."status" <> 'published' or "case_studies"."published_at" is not null),
	CONSTRAINT "case_studies_unavailable_check" CHECK (("case_studies"."status" = 'unavailable') = ("case_studies"."unavailable_at" is not null) and ("case_studies"."unavailable_reason" is null or "case_studies"."unavailable_reason" in ('withdrawn', 'replaced')))
);
--> statement-breakpoint
CREATE TABLE "competency_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"edition_id" uuid NOT NULL,
	"competency_index" integer NOT NULL,
	"case_study_id" uuid NOT NULL,
	"release_version" integer NOT NULL,
	"evidence_kind" text NOT NULL,
	"evidence_key" text NOT NULL,
	CONSTRAINT "competency_evidence_ref_key" UNIQUE("edition_id","competency_index","case_study_id","evidence_kind","evidence_key"),
	CONSTRAINT "competency_evidence_index_check" CHECK ("competency_evidence"."competency_index" between 0 and 11),
	CONSTRAINT "competency_evidence_kind_check" CHECK ("competency_evidence"."evidence_kind" in ('log', 'claim', 'milestone', 'artifact')),
	CONSTRAINT "competency_evidence_key_check" CHECK (char_length("competency_evidence"."evidence_key") between 1 and 64)
);
--> statement-breakpoint
CREATE TABLE "portfolio_editions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"headline" text,
	"competencies" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"skills_declared" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" text DEFAULT 'current' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "portfolio_editions_user_version_key" UNIQUE("user_id","version"),
	CONSTRAINT "portfolio_editions_status_check" CHECK ("portfolio_editions"."status" in ('current', 'superseded')),
	CONSTRAINT "portfolio_editions_version_check" CHECK ("portfolio_editions"."version" >= 1),
	CONSTRAINT "portfolio_editions_headline_check" CHECK ("portfolio_editions"."headline" is null or char_length("portfolio_editions"."headline") between 1 and 120),
	CONSTRAINT "portfolio_editions_competencies_array_check" CHECK (jsonb_typeof("portfolio_editions"."competencies") = 'array')
);
--> statement-breakpoint
CREATE TABLE "portfolio_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"edition_id" uuid NOT NULL,
	"case_study_id" uuid NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "portfolio_items_edition_case_key" UNIQUE("edition_id","case_study_id"),
	CONSTRAINT "portfolio_items_edition_position_key" UNIQUE("edition_id","position"),
	CONSTRAINT "portfolio_items_position_check" CHECK ("portfolio_items"."position" between 0 and 4)
);
--> statement-breakpoint
ALTER TABLE "case_sentences" ADD CONSTRAINT "case_sentences_case_study_id_case_studies_id_fk" FOREIGN KEY ("case_study_id") REFERENCES "public"."case_studies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_studies" ADD CONSTRAINT "case_studies_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_studies" ADD CONSTRAINT "case_studies_publication_id_publications_id_fk" FOREIGN KEY ("publication_id") REFERENCES "public"."publications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_studies" ADD CONSTRAINT "case_studies_release_id_publication_candidates_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."publication_candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competency_evidence" ADD CONSTRAINT "competency_evidence_edition_id_portfolio_editions_id_fk" FOREIGN KEY ("edition_id") REFERENCES "public"."portfolio_editions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competency_evidence" ADD CONSTRAINT "competency_evidence_case_study_id_case_studies_id_fk" FOREIGN KEY ("case_study_id") REFERENCES "public"."case_studies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_editions" ADD CONSTRAINT "portfolio_editions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_items" ADD CONSTRAINT "portfolio_items_edition_id_portfolio_editions_id_fk" FOREIGN KEY ("edition_id") REFERENCES "public"."portfolio_editions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_items" ADD CONSTRAINT "portfolio_items_case_study_id_case_studies_id_fk" FOREIGN KEY ("case_study_id") REFERENCES "public"."case_studies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "case_studies_user_id_idx" ON "case_studies" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "case_studies_publication_id_idx" ON "case_studies" USING btree ("publication_id");--> statement-breakpoint
CREATE INDEX "case_studies_release_id_idx" ON "case_studies" USING btree ("release_id");--> statement-breakpoint
CREATE INDEX "competency_evidence_case_study_id_idx" ON "competency_evidence" USING btree ("case_study_id");--> statement-breakpoint
CREATE UNIQUE INDEX "portfolio_editions_current_key" ON "portfolio_editions" USING btree ("user_id") WHERE "portfolio_editions"."status" = 'current';--> statement-breakpoint
CREATE INDEX "portfolio_items_case_study_id_idx" ON "portfolio_items" USING btree ("case_study_id");