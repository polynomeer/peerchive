CREATE TYPE "public"."endorsement_status" AS ENUM('confirmed', 'disputed');--> statement-breakpoint
CREATE TABLE "claim_evidence" (
	"claim_revision_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"log_entry_id" uuid,
	"log_revision_id" uuid,
	"artifact_version_id" uuid,
	CONSTRAINT "claim_evidence_pkey" PRIMARY KEY("claim_revision_id","position"),
	CONSTRAINT "claim_evidence_log_entry_key" UNIQUE("claim_revision_id","log_entry_id"),
	CONSTRAINT "claim_evidence_artifact_version_key" UNIQUE("claim_revision_id","artifact_version_id"),
	CONSTRAINT "claim_evidence_position_check" CHECK ("claim_evidence"."position" between 0 and 19),
	CONSTRAINT "claim_evidence_kind_check" CHECK (("claim_evidence"."log_entry_id" is not null and "claim_evidence"."log_revision_id" is not null and "claim_evidence"."artifact_version_id" is null)
        or ("claim_evidence"."log_entry_id" is null and "claim_evidence"."log_revision_id" is null and "claim_evidence"."artifact_version_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "claim_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"claim_id" uuid NOT NULL,
	"revision_no" integer NOT NULL,
	"text" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "claim_revisions_claim_id_revision_no_key" UNIQUE("claim_id","revision_no"),
	CONSTRAINT "claim_revisions_revision_no_check" CHECK ("claim_revisions"."revision_no" >= 1),
	CONSTRAINT "claim_revisions_text_check" CHECK (char_length("claim_revisions"."text") between 1 and 300)
);
--> statement-breakpoint
CREATE TABLE "endorsements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"claim_revision_id" uuid NOT NULL,
	"endorser_id" uuid NOT NULL,
	"status" "endorsement_status" NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "endorsements_claim_revision_endorser_key" UNIQUE("claim_revision_id","endorser_id"),
	CONSTRAINT "endorsements_note_check" CHECK ("endorsements"."note" is null or char_length("endorsements"."note") between 1 and 500)
);
--> statement-breakpoint
CREATE TABLE "role_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"current_revision_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "claim_evidence" ADD CONSTRAINT "claim_evidence_claim_revision_id_claim_revisions_id_fk" FOREIGN KEY ("claim_revision_id") REFERENCES "public"."claim_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_evidence" ADD CONSTRAINT "claim_evidence_log_entry_id_log_entries_id_fk" FOREIGN KEY ("log_entry_id") REFERENCES "public"."log_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_evidence" ADD CONSTRAINT "claim_evidence_log_revision_id_log_revisions_id_fk" FOREIGN KEY ("log_revision_id") REFERENCES "public"."log_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_evidence" ADD CONSTRAINT "claim_evidence_artifact_version_id_artifact_versions_id_fk" FOREIGN KEY ("artifact_version_id") REFERENCES "public"."artifact_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_revisions" ADD CONSTRAINT "claim_revisions_claim_id_role_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."role_claims"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "endorsements" ADD CONSTRAINT "endorsements_claim_revision_id_claim_revisions_id_fk" FOREIGN KEY ("claim_revision_id") REFERENCES "public"."claim_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "endorsements" ADD CONSTRAINT "endorsements_endorser_id_users_id_fk" FOREIGN KEY ("endorser_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_claims" ADD CONSTRAINT "role_claims_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_claims" ADD CONSTRAINT "role_claims_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_claims" ADD CONSTRAINT "role_claims_current_revision_id_fk" FOREIGN KEY ("current_revision_id") REFERENCES "public"."claim_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "claim_evidence_log_entry_id_idx" ON "claim_evidence" USING btree ("log_entry_id");--> statement-breakpoint
CREATE INDEX "claim_evidence_artifact_version_id_idx" ON "claim_evidence" USING btree ("artifact_version_id");--> statement-breakpoint
CREATE INDEX "endorsements_endorser_id_idx" ON "endorsements" USING btree ("endorser_id");--> statement-breakpoint
CREATE INDEX "role_claims_project_user_idx" ON "role_claims" USING btree ("project_id","user_id","created_at");