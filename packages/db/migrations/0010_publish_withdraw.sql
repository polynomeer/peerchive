ALTER TYPE "public"."candidate_status" ADD VALUE 'replaced';--> statement-breakpoint
ALTER TABLE "publication_candidates" ADD COLUMN "release_no" integer;--> statement-breakpoint
ALTER TABLE "publication_candidates" ADD COLUMN "published_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "publication_candidates" ADD COLUMN "replaced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "publication_candidates" ADD COLUMN "withdrawn_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "publications" ADD COLUMN "access_epoch" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "publications" ADD COLUMN "first_published_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "publications" ADD COLUMN "withdrawn_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "publications" ADD COLUMN "withdraw_cause" text;--> statement-breakpoint
ALTER TABLE "publications" ADD COLUMN "withdraw_note" text;--> statement-breakpoint
CREATE UNIQUE INDEX "publication_candidates_published_key" ON "publication_candidates" USING btree ("publication_id") WHERE "publication_candidates"."status" = 'published';--> statement-breakpoint
ALTER TABLE "publication_candidates" ADD CONSTRAINT "publication_candidates_publication_release_key" UNIQUE("publication_id","release_no");--> statement-breakpoint
ALTER TABLE "publication_candidates" ADD CONSTRAINT "publication_candidates_release_check" CHECK (("publication_candidates"."release_no" is null) = ("publication_candidates"."published_at" is null) and ("publication_candidates"."release_no" is null or "publication_candidates"."release_no" >= 1));--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_access_epoch_check" CHECK ("publications"."access_epoch" >= 0);--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_withdraw_cause_check" CHECK ("publications"."withdraw_cause" is null or "publications"."withdraw_cause" in ('owner', 'consent_revoked'));--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_withdraw_note_check" CHECK ("publications"."withdraw_note" is null or char_length("publications"."withdraw_note") between 1 and 300);