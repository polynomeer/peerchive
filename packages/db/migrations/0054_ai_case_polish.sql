CREATE TABLE "case_ai_polish_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_study_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"base_version" integer NOT NULL,
	"suggestions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "case_ai_polish_proposals_case_key" UNIQUE("case_study_id"),
	CONSTRAINT "case_ai_polish_proposals_version_check" CHECK ("case_ai_polish_proposals"."base_version" >= 1),
	CONSTRAINT "case_ai_polish_proposals_suggestions_check" CHECK (jsonb_typeof("case_ai_polish_proposals"."suggestions") = 'array')
);
--> statement-breakpoint
ALTER TABLE "case_studies" DROP CONSTRAINT "case_studies_generator_check";--> statement-breakpoint
ALTER TABLE "case_sentences" ADD COLUMN "ai_generated" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "case_ai_polish_proposals" ADD CONSTRAINT "case_ai_polish_proposals_case_study_id_case_studies_id_fk" FOREIGN KEY ("case_study_id") REFERENCES "public"."case_studies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_ai_polish_proposals" ADD CONSTRAINT "case_ai_polish_proposals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "case_ai_polish_proposals_user_idx" ON "case_ai_polish_proposals" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "case_ai_polish_proposals_expires_at_idx" ON "case_ai_polish_proposals" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "case_studies" ADD CONSTRAINT "case_studies_generator_check" CHECK ("case_studies"."generator" in ('template', 'ai'));