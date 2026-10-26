CREATE TYPE "public"."affiliation_method" AS ENUM('email');--> statement-breakpoint
CREATE TYPE "public"."affiliation_standing" AS ENUM('student', 'alumni');--> statement-breakpoint
CREATE TYPE "public"."affiliation_status" AS ENUM('pending', 'active', 'revoked', 'expired');--> statement-breakpoint
CREATE TYPE "public"."institution_kind" AS ENUM('university');--> statement-breakpoint
ALTER TYPE "public"."analytics_event_name" ADD VALUE 'affiliation_verified';--> statement-breakpoint
CREATE TABLE "affiliation_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"affiliation_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "affiliation_codes_code_hash_check" CHECK ("affiliation_codes"."code_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "affiliation_codes_attempts_check" CHECK ("affiliation_codes"."attempts" between 0 and 5)
);
--> statement-breakpoint
CREATE TABLE "institution_affiliations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"institution_kind" "institution_kind" DEFAULT 'university' NOT NULL,
	"school_id" uuid NOT NULL,
	"method" "affiliation_method" DEFAULT 'email' NOT NULL,
	"email_hash" text,
	"email_domain" text NOT NULL,
	"standing" "affiliation_standing" NOT NULL,
	"department_label" text,
	"status" "affiliation_status" DEFAULT 'pending' NOT NULL,
	"verified_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "institution_affiliations_email_hash_check" CHECK ("institution_affiliations"."email_hash" is null or "institution_affiliations"."email_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "institution_affiliations_open_hash_check" CHECK ("institution_affiliations"."status" not in ('pending', 'active') or "institution_affiliations"."email_hash" is not null),
	CONSTRAINT "institution_affiliations_active_verified_check" CHECK ("institution_affiliations"."status" <> 'active' or "institution_affiliations"."verified_at" is not null),
	CONSTRAINT "institution_affiliations_revoked_check" CHECK ("institution_affiliations"."status" <> 'revoked' or ("institution_affiliations"."revoked_at" is not null and "institution_affiliations"."revoked_reason" is not null)),
	CONSTRAINT "institution_affiliations_department_label_check" CHECK ("institution_affiliations"."department_label" is null or char_length("institution_affiliations"."department_label") between 1 and 40),
	CONSTRAINT "institution_affiliations_email_domain_check" CHECK (char_length("institution_affiliations"."email_domain") between 3 and 253),
	CONSTRAINT "institution_affiliations_revoked_reason_check" CHECK ("institution_affiliations"."revoked_reason" is null or "institution_affiliations"."revoked_reason" in ('user_removed', 'operator', 'merged_duplicate'))
);
--> statement-breakpoint
CREATE TABLE "school_email_domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"domain" text NOT NULL,
	"added_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "school_email_domains_domain_check" CHECK ("school_email_domains"."domain" ~ '^[a-z0-9]([a-z0-9.-]{1,251})[a-z0-9]$' and "school_email_domains"."domain" like '%.%')
);
--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "show_affiliation_badge" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "affiliation_codes" ADD CONSTRAINT "affiliation_codes_affiliation_id_institution_affiliations_id_fk" FOREIGN KEY ("affiliation_id") REFERENCES "public"."institution_affiliations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "institution_affiliations" ADD CONSTRAINT "institution_affiliations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "institution_affiliations" ADD CONSTRAINT "institution_affiliations_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "school_email_domains" ADD CONSTRAINT "school_email_domains_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "school_email_domains" ADD CONSTRAINT "school_email_domains_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "affiliation_codes_affiliation_id_idx" ON "affiliation_codes" USING btree ("affiliation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "institution_affiliations_email_hash_active_key" ON "institution_affiliations" USING btree ("email_hash") WHERE "institution_affiliations"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "institution_affiliations_user_school_open_key" ON "institution_affiliations" USING btree ("user_id","school_id") WHERE "institution_affiliations"."status" in ('pending', 'active');--> statement-breakpoint
CREATE INDEX "institution_affiliations_user_id_idx" ON "institution_affiliations" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "institution_affiliations_school_id_idx" ON "institution_affiliations" USING btree ("school_id");--> statement-breakpoint
CREATE UNIQUE INDEX "school_email_domains_domain_key" ON "school_email_domains" USING btree ("domain");--> statement-breakpoint
CREATE INDEX "school_email_domains_school_id_idx" ON "school_email_domains" USING btree ("school_id");