ALTER TYPE "public"."affiliation_method" ADD VALUE 'invite_code';--> statement-breakpoint
ALTER TYPE "public"."affiliation_method" ADD VALUE 'cohort_approval';--> statement-breakpoint
ALTER TYPE "public"."affiliation_method" ADD VALUE 'certificate_check';--> statement-breakpoint
ALTER TYPE "public"."institution_kind" ADD VALUE 'bootcamp';--> statement-breakpoint
ALTER TYPE "public"."institution_kind" ADD VALUE 'training_program';--> statement-breakpoint
ALTER TYPE "public"."institution_kind" ADD VALUE 'club_federation';--> statement-breakpoint
CREATE TABLE "certificate_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"affiliation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"object_key" text,
	"declared_type" text NOT NULL,
	"file_extension" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"sha256" text,
	"uploaded_at" timestamp with time zone,
	"scan_status" "scan_status" DEFAULT 'pending' NOT NULL,
	"scan_reason" text,
	"scan_engine" text,
	"scan_attempts" integer DEFAULT 0 NOT NULL,
	"scanned_at" timestamp with time zone,
	"media_type" text,
	"result" text,
	"reviewed_by" uuid,
	"decided_at" timestamp with time zone,
	"file_purged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "certificate_checks_result_check" CHECK ("certificate_checks"."result" is null or "certificate_checks"."result" in ('approved', 'rejected')),
	CONSTRAINT "certificate_checks_decided_check" CHECK (("certificate_checks"."result" is null) = ("certificate_checks"."decided_at" is null)),
	CONSTRAINT "certificate_checks_purged_check" CHECK ("certificate_checks"."file_purged_at" is null or "certificate_checks"."object_key" is null),
	CONSTRAINT "certificate_checks_object_key_check" CHECK ("certificate_checks"."object_key" is null or "certificate_checks"."object_key" ~ '^quarantine/[0-9a-f-]{36}$'),
	CONSTRAINT "certificate_checks_extension_check" CHECK ("certificate_checks"."file_extension" in ('png', 'jpg', 'jpeg', 'webp', 'pdf')),
	CONSTRAINT "certificate_checks_byte_size_check" CHECK ("certificate_checks"."byte_size" between 1 and 10485760),
	CONSTRAINT "certificate_checks_sha256_check" CHECK ("certificate_checks"."sha256" is null or "certificate_checks"."sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "cohort_approvals" (
	"affiliation_id" uuid NOT NULL,
	"approver_user_id" uuid NOT NULL,
	"approver_affiliation_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cohort_approvals_affiliation_id_approver_user_id_pk" PRIMARY KEY("affiliation_id","approver_user_id")
);
--> statement-breakpoint
CREATE TABLE "institution_cohorts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"label" text NOT NULL,
	"label_key" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "institution_cohorts_label_check" CHECK (char_length("institution_cohorts"."label") between 1 and 20),
	CONSTRAINT "institution_cohorts_label_key_check" CHECK (char_length("institution_cohorts"."label_key") between 1 and 20)
);
--> statement-breakpoint
CREATE TABLE "institution_invite_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"cohort_id" uuid,
	"code_hash" text NOT NULL,
	"issued_by" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"max_uses" integer NOT NULL,
	"used_count" integer DEFAULT 0 NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "institution_invite_codes_code_hash_check" CHECK ("institution_invite_codes"."code_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "institution_invite_codes_max_uses_check" CHECK ("institution_invite_codes"."max_uses" between 1 and 1000),
	CONSTRAINT "institution_invite_codes_used_count_check" CHECK ("institution_invite_codes"."used_count" >= 0 and "institution_invite_codes"."used_count" <= "institution_invite_codes"."max_uses")
);
--> statement-breakpoint
ALTER TABLE "deletion_ledger" DROP CONSTRAINT "deletion_ledger_source_check";--> statement-breakpoint
ALTER TABLE "institution_affiliations" DROP CONSTRAINT "institution_affiliations_open_hash_check";--> statement-breakpoint
ALTER TABLE "institution_affiliations" DROP CONSTRAINT "institution_affiliations_email_domain_check";--> statement-breakpoint
ALTER TABLE "institution_affiliations" DROP CONSTRAINT "institution_affiliations_revoked_reason_check";--> statement-breakpoint
ALTER TABLE "institution_affiliations" ALTER COLUMN "email_domain" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "institution_affiliations" ADD COLUMN "cohort_id" uuid;--> statement-breakpoint
ALTER TABLE "schools" ADD COLUMN "kind" "institution_kind" DEFAULT 'university' NOT NULL;--> statement-breakpoint
ALTER TABLE "certificate_checks" ADD CONSTRAINT "certificate_checks_affiliation_id_institution_affiliations_id_fk" FOREIGN KEY ("affiliation_id") REFERENCES "public"."institution_affiliations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "certificate_checks" ADD CONSTRAINT "certificate_checks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "certificate_checks" ADD CONSTRAINT "certificate_checks_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cohort_approvals" ADD CONSTRAINT "cohort_approvals_affiliation_id_institution_affiliations_id_fk" FOREIGN KEY ("affiliation_id") REFERENCES "public"."institution_affiliations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cohort_approvals" ADD CONSTRAINT "cohort_approvals_approver_user_id_users_id_fk" FOREIGN KEY ("approver_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cohort_approvals" ADD CONSTRAINT "cohort_approvals_approver_affiliation_id_institution_affiliations_id_fk" FOREIGN KEY ("approver_affiliation_id") REFERENCES "public"."institution_affiliations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "institution_cohorts" ADD CONSTRAINT "institution_cohorts_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "institution_cohorts" ADD CONSTRAINT "institution_cohorts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "institution_invite_codes" ADD CONSTRAINT "institution_invite_codes_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "institution_invite_codes" ADD CONSTRAINT "institution_invite_codes_cohort_id_institution_cohorts_id_fk" FOREIGN KEY ("cohort_id") REFERENCES "public"."institution_cohorts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "institution_invite_codes" ADD CONSTRAINT "institution_invite_codes_issued_by_users_id_fk" FOREIGN KEY ("issued_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "certificate_checks_affiliation_id_key" ON "certificate_checks" USING btree ("affiliation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "certificate_checks_object_key_key" ON "certificate_checks" USING btree ("object_key");--> statement-breakpoint
CREATE INDEX "certificate_checks_user_id_idx" ON "certificate_checks" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "certificate_checks_open_idx" ON "certificate_checks" USING btree ("created_at") WHERE "certificate_checks"."file_purged_at" is null;--> statement-breakpoint
CREATE INDEX "cohort_approvals_approver_user_id_idx" ON "cohort_approvals" USING btree ("approver_user_id");--> statement-breakpoint
CREATE INDEX "cohort_approvals_approver_affiliation_id_idx" ON "cohort_approvals" USING btree ("approver_affiliation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "institution_cohorts_school_label_key" ON "institution_cohorts" USING btree ("school_id","label_key");--> statement-breakpoint
CREATE UNIQUE INDEX "institution_invite_codes_code_hash_key" ON "institution_invite_codes" USING btree ("code_hash");--> statement-breakpoint
CREATE INDEX "institution_invite_codes_school_id_idx" ON "institution_invite_codes" USING btree ("school_id");--> statement-breakpoint
ALTER TABLE "institution_affiliations" ADD CONSTRAINT "institution_affiliations_cohort_id_institution_cohorts_id_fk" FOREIGN KEY ("cohort_id") REFERENCES "public"."institution_cohorts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "institution_affiliations_cohort_id_idx" ON "institution_affiliations" USING btree ("cohort_id");--> statement-breakpoint
CREATE INDEX "schools_kind_idx" ON "schools" USING btree ("kind");--> statement-breakpoint
ALTER TABLE "deletion_ledger" ADD CONSTRAINT "deletion_ledger_source_check" CHECK ("deletion_ledger"."source" in ('purge', 'reapply', 'retention'));--> statement-breakpoint
ALTER TABLE "institution_affiliations" ADD CONSTRAINT "institution_affiliations_email_method_check" CHECK ("institution_affiliations"."method"::text = 'email' or "institution_affiliations"."email_hash" is null);--> statement-breakpoint
ALTER TABLE "institution_affiliations" ADD CONSTRAINT "institution_affiliations_email_domain_required_check" CHECK ("institution_affiliations"."method"::text <> 'email' or "institution_affiliations"."email_domain" is not null);--> statement-breakpoint
ALTER TABLE "institution_affiliations" ADD CONSTRAINT "institution_affiliations_cohort_required_check" CHECK ("institution_affiliations"."method"::text <> 'cohort_approval' or "institution_affiliations"."cohort_id" is not null);--> statement-breakpoint
ALTER TABLE "institution_affiliations" ADD CONSTRAINT "institution_affiliations_open_hash_check" CHECK ("institution_affiliations"."method"::text <> 'email' or "institution_affiliations"."status" not in ('pending', 'active') or "institution_affiliations"."email_hash" is not null);--> statement-breakpoint
ALTER TABLE "institution_affiliations" ADD CONSTRAINT "institution_affiliations_email_domain_check" CHECK ("institution_affiliations"."email_domain" is null or char_length("institution_affiliations"."email_domain") between 3 and 253);--> statement-breakpoint
ALTER TABLE "institution_affiliations" ADD CONSTRAINT "institution_affiliations_revoked_reason_check" CHECK ("institution_affiliations"."revoked_reason" is null or "institution_affiliations"."revoked_reason" in ('user_removed', 'operator', 'merged_duplicate', 'certificate_rejected'));